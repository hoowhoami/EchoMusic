import logger from '@/utils/logger';

/**
 * 分页数据获取器
 * 返回本页数据项和是否还有更多页
 */
export interface PageFetcher<T> {
  (page: number, pageSize: number): Promise<{ items: T[]; hasMore: boolean }>;
}

/**
 * 分页加载器配置
 */
export interface PagedLoaderOptions<T> {
  /** 每页大小，默认 200 */
  pageSize?: number;
  /** 并发请求数，默认 3 */
  concurrency?: number;
  /** 去重 key 提取函数 */
  dedupeKey?: (item: T) => string;
  /** 每页加载完成回调（增量通知） */
  onPageLoaded?: (allItems: readonly T[], newItems: readonly T[], page: number) => void;
  /** 全部加载完成回调 */
  onComplete?: (allItems: readonly T[]) => void;
  /** 加载出错回调 */
  onError?: (error: unknown) => void;
  /** 日志模块名 */
  logTag?: string;
  /** 最大页数限制，默认 100 */
  maxPages?: number;
}

/**
 * 通用分页数据加载器
 *
 * 非响应式设计，内部使用普通数组存储数据。
 * 通过回调通知外部更新 UI（由调用方决定用 shallowRef 等方式触发渲染）。
 */
export class PagedSongLoader<T> {
  private _items: T[] = [];
  private _loading = false;
  private _fullyLoaded = false;
  private _aborted = false;
  private _loadedPages = 0;
  private _seenKeys = new Set<string>();
  private _completionPromise: Promise<readonly T[]> | null = null;
  private _completionResolve: ((items: readonly T[]) => void) | null = null;

  private readonly fetcher: PageFetcher<T>;
  private readonly pageSize: number;
  private readonly concurrency: number;
  private readonly dedupeKey: ((item: T) => string) | null;
  private readonly onPageLoaded: PagedLoaderOptions<T>['onPageLoaded'];
  private readonly onComplete: PagedLoaderOptions<T>['onComplete'];
  private readonly onError: PagedLoaderOptions<T>['onError'];
  private readonly logTag: string;
  private readonly maxPages: number;

  constructor(fetcher: PageFetcher<T>, options: PagedLoaderOptions<T> = {}) {
    this.fetcher = fetcher;
    this.pageSize = options.pageSize ?? 200;
    this.concurrency = options.concurrency ?? 3;
    this.dedupeKey = options.dedupeKey ?? null;
    this.onPageLoaded = options.onPageLoaded;
    this.onComplete = options.onComplete;
    this.onError = options.onError;
    this.logTag = options.logTag ?? 'PagedLoader';
    this.maxPages = options.maxPages ?? 100;
  }

  /** 当前已加载的数据（只读） */
  get items(): readonly T[] {
    return this._items;
  }

  /** 是否正在加载 */
  get loading(): boolean {
    return this._loading;
  }

  /** 是否已全部加载完成 */
  get fullyLoaded(): boolean {
    return this._fullyLoaded;
  }

  /** 已加载数量 */
  get count(): number {
    return this._items.length;
  }

  /** 已加载页数 */
  get loadedPages(): number {
    return this._loadedPages;
  }

  /** 获取当前数据快照（普通数组副本） */
  snapshot(): T[] {
    return this._items.slice();
  }

  /**
   * 加载首页数据
   * 快速返回第一页结果，供 UI 立即渲染
   */
  async loadFirstPage(): Promise<readonly T[]> {
    if (this._aborted) return this._items;
    this._loading = true;

    try {
      const { items, hasMore } = await this.fetcher(1, this.pageSize);
      if (this._aborted) return this._items;

      const deduped = this.deduplicateAndAppend(items);
      this._loadedPages = 1;

      if (deduped.length > 0) {
        this.onPageLoaded?.(this._items, deduped, 1);
      }

      if (!hasMore) {
        this.markComplete();
      }

      logger.info(this.logTag, `First page load finished`, {
        count: this._items.length,
        hasMore,
      });

      return this._items;
    } catch (error) {
      if (!this._aborted) {
        logger.warn(this.logTag, 'First page load failed:', error);
        this.onError?.(error);
        this.markComplete();
      }
      return this._items;
    }
  }

  /**
   * 后台加载剩余所有页
   * 使用有限并发控制，保持页序正确
   */
  async loadRemaining(): Promise<readonly T[]> {
    if (this._fullyLoaded || this._aborted) return this._items;
    if (this._loadedPages === 0) {
      await this.loadFirstPage();
      if (this._fullyLoaded || this._aborted) return this._items;
    }

    this._loading = true;
    let nextPage = this._loadedPages + 1;

    try {
      let keepGoing = true;

      while (keepGoing && !this._aborted && nextPage <= this.maxPages) {
        // 构建一批并发请求
        const batch: number[] = [];
        for (let i = 0; i < this.concurrency && nextPage + i <= this.maxPages; i++) {
          batch.push(nextPage + i);
        }

        // 并发请求
        const results = await Promise.allSettled(
          batch.map((page) => this.fetcher(page, this.pageSize)),
        );

        if (this._aborted) break;

        // 按页序处理结果
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          const page = batch[i];

          if (result.status === 'rejected') {
            logger.warn(this.logTag, `第 ${page} 页加载失败:`, result.reason);
            keepGoing = false;
            break;
          }

          const { items, hasMore } = result.value;

          if (this._aborted) {
            keepGoing = false;
            break;
          }

          const deduped = this.deduplicateAndAppend(items);
          this._loadedPages = page;

          if (deduped.length > 0) {
            this.onPageLoaded?.(this._items, deduped, page);
          }

          // 终止条件：API 返回空数据、去重后无新增、或 fetcher 标记无更多页
          if (items.length === 0 || deduped.length === 0 || !hasMore) {
            keepGoing = false;
            break;
          }
        }

        nextPage += batch.length;
      }
    } catch (error) {
      if (!this._aborted) {
        logger.warn(this.logTag, '后台加载失败:', error);
        this.onError?.(error);
      }
    }

    this.markComplete();
    return this._items;
  }

  /**
   * 一次性加载所有数据（首页 + 剩余页）
   * 首页加载完立即回调，剩余页后台并发加载
   */
  async loadAll(): Promise<readonly T[]> {
    await this.loadFirstPage();
    if (!this._fullyLoaded && !this._aborted) {
      await this.loadRemaining();
    }
    return this._items;
  }

  /**
   * 等待全部加载完成
   * 如果已经加载完，立即返回；否则等待后台加载结束
   */
  waitForAll(): Promise<readonly T[]> {
    if (this._fullyLoaded) return Promise.resolve(this._items);

    if (!this._completionPromise) {
      this._completionPromise = new Promise<readonly T[]>((resolve) => {
        this._completionResolve = resolve;
      });
    }
    return this._completionPromise;
  }

  /** 中止加载 */
  abort(): void {
    this._aborted = true;
    this.markComplete();
  }

  /** 重置状态 */
  reset(): void {
    this._aborted = true;
    this._items = [];
    this._loading = false;
    this._fullyLoaded = false;
    this._loadedPages = 0;
    this._seenKeys.clear();
    this._completionPromise = null;
    this._completionResolve = null;
    // 重置后允许重新加载
    this._aborted = false;
  }

  /** 去重并追加到内部数组 */
  private deduplicateAndAppend(items: T[]): T[] {
    if (!this.dedupeKey) {
      this._items.push(...items);
      return items;
    }

    const added: T[] = [];
    for (const item of items) {
      const key = this.dedupeKey(item);
      if (this._seenKeys.has(key)) continue;
      this._seenKeys.add(key);
      added.push(item);
    }
    if (added.length > 0) {
      this._items.push(...added);
    }
    return added;
  }

  /** 标记加载完成 */
  private markComplete(): void {
    this._loading = false;
    this._fullyLoaded = true;
    this.onComplete?.(this._items);
    if (this._completionResolve) {
      this._completionResolve(this._items);
      this._completionResolve = null;
    }
    logger.info(this.logTag, `load completed`, {
      total: this._items.length,
      pages: this._loadedPages,
    });
  }
}
