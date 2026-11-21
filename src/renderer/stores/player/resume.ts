import type { PlayerState, ResumeClaim, ResumePosition } from './state';
import type { PlayMode } from '../../types';
import { HISTORY_MAX_ENTRIES } from '@/utils/historyLimits';

/**
 * 续播的准入只看时长：任何超过 30 秒的内容都记进度（太短的片段记了也没意义），
 * 不区分「长音频」与普通歌曲 —— 普通歌曲记在单曲线（single）上，从专辑/歌手/歌单/
 * 有声详情页起播的记在对应的桶线（album:1 / artist:1 / playlist:1 / audiobook:1）上。
 * 同一首在不同线各记各的，起播时只读当前这条线。
 */
export const RESUME_MIN_DURATION_SEC = 30;
/** 接着播时往回倒 3 秒，免得正好卡在上一句结尾。 */
export const RESUME_REWIND_SEC = 3;
/** 每种详情页（有声、专辑、歌手、歌单）最多记多少个：跟播放历史共用同一份容量上限。 */
export const RESUME_MAX_PER_KIND = HISTORY_MAX_ENTRIES;

export const RESUME_SINGLE_ENTRY = 'single';

export type ResumeScopeKind = 'audiobook' | 'album' | 'artist' | 'playlist';

/** 同一次播放命中多个桶时的优先级：有声 > 歌手 > 专辑 > 歌单。 */
export const RESUME_SCOPE_PRIORITY: ResumeScopeKind[] = [
  'audiobook',
  'artist',
  'album',
  'playlist',
];

export const RESUME_SCOPE_LABEL: Record<ResumeScopeKind, string> = {
  audiobook: '有声',
  album: '专辑',
  artist: '歌手',
  playlist: '歌单',
};

export type ResumeState = Pick<PlayerState, 'resumePositions' | 'resumeScopes'> & {
  /** 当前起播的认领来源；缺省等于没有认领（单曲线）。 */
  resumeClaim?: ResumeClaim | null;
};

export interface ResumeEntryContext {
  playMode?: PlayMode;
  albumId?: string | number | null;
  trackId?: string | number | null;
}

export interface ResumeScopeMeta {
  name?: string;
  cover?: string;
  /** 歌单页专用：路由里的 collection 串，建桶时一并存下，历史页收藏/跳转要用。 */
  routeId?: string;
  /** 歌单页专用：路由上的 type（user / special / album）。 */
  routeType?: string;
}

const toKey = (value: unknown): string => String(value ?? '').trim();
const touch = (): number => Date.now();

const scopeEntry = (kind: ResumeScopeKind, id: string): string => `${kind}:${id}`;

export const parseScopeEntry = (entry: string): { kind: ResumeScopeKind; id: string } | null => {
  const text = toKey(entry);
  const index = text.indexOf(':');
  if (index <= 0) return null;
  const kind = text.slice(0, index) as ResumeScopeKind;
  const id = text.slice(index + 1).trim();
  if (!id) return null;
  if (!RESUME_SCOPE_PRIORITY.includes(kind)) return null;
  return { kind, id };
};

interface ScopeMetaValue {
  name: string;
  cover: string;
  routeId: string;
  routeType: string;
}

type ScopeMetaCache = Map<string, ScopeMetaValue>;

/** 详情页打开时先把名字/封面寄存在这里：没播放就不建桶，真播了再拿它建桶。 */
const scopeMetaCache: ScopeMetaCache = new Map();

const metaKey = (kind: ResumeScopeKind, id: string): string => kind + ':' + id;

/** 详情页元数据只是「页面打开 → 首次播放」之间的交接棒，留最近打开过的 100 个页面就够。 */
const SCOPE_META_LIMIT = 100;

const cacheMeta = (key: string, value: ScopeMetaValue): void => {
  scopeMetaCache.delete(key);
  scopeMetaCache.set(key, value);
  while (scopeMetaCache.size > SCOPE_META_LIMIT) {
    const oldest = scopeMetaCache.keys().next();
    if (oldest.done) break;
    scopeMetaCache.delete(oldest.value);
  }
};

const readMeta = (key: string) => {
  const value = scopeMetaCache.get(key);
  if (value) cacheMeta(key, value);
  return value;
};

const findScope = (
  state: ResumeState,
  kind: ResumeScopeKind,
  id: string,
): PlayerState['resumeScopes'][number] | null =>
  state.resumeScopes.find((scope) => scope.kind === kind && scope.id === id) ?? null;

/** 认领来的这首必须真的属于那个详情页：有声章节、专辑曲目的 albumId 就是它。 */
const scopeOwnsTrack = (
  scope: { kind: ResumeScopeKind; id: string },
  albumId: unknown,
): boolean => {
  // 歌手页与歌单页的归属由页面自己判定（歌手看歌手 id，歌单看播放队列/曲目是否在表里）
  if (scope.kind === 'artist' || scope.kind === 'playlist') return true;
  const id = toKey(albumId);
  return id !== '' && id === scope.id;
};

export const resolveResumeEntry = (state: ResumeState, context: ResumeEntryContext): string => {
  // 随机播放不认领任何桶：乱序跳着听不构成「在听这张专辑 / 这本书」。
  if (context.playMode === 'random') return RESUME_SINGLE_ENTRY;
  // 只有详情页点播会带认领标记（queueOptions.resumeScope）：搜索、收藏、歌词搜索、
  // 歌词行双击、推荐、历史这些入口不带，哪怕这一首恰好属于某本书，也一律记单曲线，
  // 否则卡片上原来的章节名会被顶掉。
  const claim = state.resumeClaim ?? null;
  if (claim && scopeOwnsTrack(claim, context.albumId)) {
    return scopeEntry(claim.kind, claim.id);
  }
  // 已经由某个桶认领的曲目（详情页整张连播的下一首）继续留在那个桶里，
  // 否则自动连播会退回单曲线，桶里那条记录就成了没人维护的孤儿。
  const ownerTrackId = toKey(context.trackId);
  if (ownerTrackId) {
    const owner = state.resumeScopes.find(
      (scope) => scope.trackId === ownerTrackId && scopeOwnsTrack(scope, context.albumId),
    );
    if (owner) return scopeEntry(owner.kind, owner.id);
  }
  return RESUME_SINGLE_ENTRY;
};

/**
 * 进度记录按「曲目 → 记录线」两层存：同一首曲目可以同时属于专辑卡、歌单卡和自己的单曲播放，
 * 各条线互不覆盖，也就不会出现「换条线听一次，别的卡上的进度跟着被删」。
 */
type ResumeLines = Record<string, ResumePosition>;

const isResumeRecord = (value: unknown): value is ResumePosition => {
  if (!value || typeof value !== 'object') return false;
  const record = value as Partial<ResumePosition>;
  return typeof record.position === 'number' && typeof record.entry === 'string';
};

const entryKey = (entry: unknown): string => toKey(entry) || RESUME_SINGLE_ENTRY;

/** 旧快照里进度只有一层「曲目 → 记录」：读到就地升级成两层，记录本身原样保留。 */
const upgradeLegacyPositions = (state: ResumeState): void => {
  const positions = state.resumePositions as unknown as Record<
    string,
    ResumePosition | ResumeLines
  >;
  for (const trackId of Object.keys(positions)) {
    const value = positions[trackId];
    if (isResumeRecord(value)) {
      positions[trackId] = { [entryKey(value.entry)]: value };
      continue;
    }
    if (!value || typeof value !== 'object') delete positions[trackId];
  }
};

/** 写路径专用：拿到这首曲目的记录线表，遇到旧结构顺手升级。 */
const linesOf = (state: ResumeState, trackId: string): ResumeLines => {
  const positions = state.resumePositions as unknown as Record<
    string,
    ResumePosition | ResumeLines
  >;
  const value = positions[trackId];
  if (isResumeRecord(value)) {
    const upgraded: ResumeLines = { [entryKey(value.entry)]: value };
    positions[trackId] = upgraded;
    return upgraded;
  }
  if (value) return value;
  const created: ResumeLines = {};
  positions[trackId] = created;
  return created;
};

/** 读路径：只认本条记录线，别的线记的进度一点都不沾，也不删别人的。 */
const lineOf = (state: ResumeState, trackId: string, entry: string): ResumePosition | undefined => {
  const key = toKey(trackId);
  if (!key) return undefined;
  const value = state.resumePositions[key] as unknown as ResumePosition | ResumeLines | undefined;
  if (!value) return undefined;
  if (isResumeRecord(value)) return entryKey(value.entry) === entryKey(entry) ? value : undefined;
  return value[entryKey(entry)];
};

/** 这首曲目上最近写过的那条线：认领和「是不是从单曲播放进来的」判断用它。 */
const newestLineOf = (state: ResumeState, trackId: string): ResumePosition | undefined => {
  const key = toKey(trackId);
  if (!key) return undefined;
  const value = state.resumePositions[key] as unknown as ResumePosition | ResumeLines | undefined;
  if (!value) return undefined;
  if (isResumeRecord(value)) return value;
  let newest: ResumePosition | undefined;
  for (const record of Object.values(value)) {
    if (!record) continue;
    if (!newest || Number(record.updatedAt ?? 0) > Number(newest.updatedAt ?? 0)) newest = record;
  }
  return newest;
};

/** 只丢掉这一条记录线；这首曲目上的其它线（别的卡）原样保留。 */
const dropLine = (state: ResumeState, trackId: string, entry: string): void => {
  const key = toKey(trackId);
  if (!key) return;
  const value = state.resumePositions[key] as unknown as ResumePosition | ResumeLines | undefined;
  if (!value) return;
  if (isResumeRecord(value)) {
    if (entryKey(value.entry) === entryKey(entry)) delete state.resumePositions[key];
    return;
  }
  delete value[entryKey(entry)];
  if (!Object.keys(value).length) delete state.resumePositions[key];
};

/** 整首曲目的所有进度（用户主动忘掉 / 历史里已经没有它了）。 */
const dropTrack = (state: ResumeState, trackId: string): void => {
  const key = toKey(trackId);
  if (key && state.resumePositions[key]) delete state.resumePositions[key];
};

/** 桶里存的只是「当前那一首」；没人指向的位置记录顺手清掉。 */
const pruneUnreferenced = (state: ResumeState): void => {
  const positions = state.resumePositions as unknown as Record<
    string,
    ResumePosition | ResumeLines
  >;
  for (const trackId of Object.keys(positions)) {
    const value = positions[trackId];
    if (!value) continue;
    if (isResumeRecord(value)) {
      const single = entryKey(value.entry) === RESUME_SINGLE_ENTRY;
      if (!single && !state.resumeScopes.some((scope) => scope.trackId === trackId)) {
        delete positions[trackId];
      }
      continue;
    }
    for (const line of Object.keys(value)) {
      if (line === RESUME_SINGLE_ENTRY) continue;
      const referenced = state.resumeScopes.some(
        (scope) => scope.trackId === trackId && scopeEntry(scope.kind, scope.id) === line,
      );
      if (!referenced) delete value[line];
    }
    if (!Object.keys(value).length) delete positions[trackId];
  }
};

/** 单曲线只有一条：换了曲目就把上一条丢掉，其它记录线一概不碰。 */
const dropStaleSingle = (state: ResumeState, keepTrackId: string): void => {
  for (const trackId of Object.keys(state.resumePositions)) {
    if (trackId === keepTrackId) continue;
    dropLine(state, trackId, RESUME_SINGLE_ENTRY);
  }
};

const trimKind = (state: ResumeState, kind: ResumeScopeKind): void => {
  const ids = state.resumeScopes.filter((scope) => scope.kind === kind).map((scope) => scope.id);
  if (ids.length <= RESUME_MAX_PER_KIND) return;
  const evicted = new Set(ids.slice(RESUME_MAX_PER_KIND));
  for (let index = state.resumeScopes.length - 1; index >= 0; index -= 1) {
    const scope = state.resumeScopes[index];
    if (scope && scope.kind === kind && evicted.has(scope.id)) {
      if (scope.trackId) dropLine(state, scope.trackId, scopeEntry(scope.kind, scope.id));
      state.resumeScopes.splice(index, 1);
    }
  }
  pruneUnreferenced(state);
};

/** 进详情页就登记：只记「我曾经打开过这个歌单 / 这张专辑 / 这位歌手」，不代表听过。 */
export const registerResumeScope = (
  state: ResumeState,
  kind: ResumeScopeKind,
  id: string,
  meta?: ResumeScopeMeta,
): void => {
  const key = toKey(id);
  if (!key) return;
  const name = toKey(meta?.name);
  const cover = toKey(meta?.cover);
  const routeId = toKey(meta?.routeId);
  const routeType = toKey(meta?.routeType);
  const cachedKey = metaKey(kind, key);
  const cached = readMeta(cachedKey);
  if (name || cover || routeId || !cached) {
    cacheMeta(cachedKey, {
      name: name || cached?.name || '',
      cover: cover || cached?.cover || '',
      routeId: routeId || cached?.routeId || '',
      routeType: routeType || cached?.routeType || '',
    });
  }
  // 只是打开过详情页，不建桶：等真正播放了再按寄存的元数据建。
  const existing = findScope(state, kind, key);
  if (!existing) return;
  if (name && existing.name !== name) existing.name = name;
  if (cover && existing.cover !== cover) existing.cover = cover;
  if (routeId && existing.routeId !== routeId) existing.routeId = routeId;
  if (routeType && existing.routeType !== routeType) existing.routeType = routeType;
};

/** 没有进度的桶一律不留：没播过的空桶、进度记录已经没了的桶、以及已经取消的桶类型（如歌单）。 */
export const pruneEmptyScopes = (state: ResumeState): void => {
  upgradeLegacyPositions(state);
  // 桶活不活，只看「它自己那条记录线」：别的线记的进度不能替它续命，删别的线也不该连坐它。
  const hasProgress = (scope: PlayerState['resumeScopes'][number]): boolean => {
    const trackId = toKey(scope?.trackId);
    if (!trackId) return false;
    const record = lineOf(state, trackId, scopeEntry(scope.kind, scope.id));
    return !!record && record.position > 0;
  };
  for (let index = state.resumeScopes.length - 1; index >= 0; index -= 1) {
    const scope = state.resumeScopes[index];
    if (!scope || !RESUME_SCOPE_PRIORITY.includes(scope.kind) || !hasProgress(scope)) {
      state.resumeScopes.splice(index, 1);
    }
  }
  pruneUnreferenced(state);
};

export const forgetResumeScope = (state: ResumeState, kind: ResumeScopeKind, id: string): void => {
  upgradeLegacyPositions(state);
  const key = toKey(id);
  if (!key) return;
  const index = state.resumeScopes.findIndex((scope) => scope.kind === kind && scope.id === key);
  if (index < 0) return;
  const [removed] = state.resumeScopes.splice(index, 1);
  if (removed?.trackId) dropLine(state, removed.trackId, scopeEntry(kind, key));
  // 正好在播这本/这张时，把认领一起撤掉：否则每秒一次的写入会照旧认领这个桶，
  // 一秒后把它原地重建回来，用户的删除看起来等于没生效。
  if (state.resumeClaim && state.resumeClaim.kind === kind && toKey(state.resumeClaim.id) === key) {
    state.resumeClaim = null;
  }
  pruneUnreferenced(state);
};

/** 按 id 找桶条目，找不到返回 null（给详情页判断「这本书以前听过没有」）。 */
export const findResumeScope = (
  state: ResumeState,
  kind: ResumeScopeKind,
  id: string,
): PlayerState['resumeScopes'][number] | null => findScope(state, kind, toKey(id));

/** 起播位置：只读本条记录线，接着它上次的位置（往回倒几秒）；别的线记的进度既不用也不动。 */
export const resolveResumePosition = (
  state: ResumeState,
  trackId: string,
  duration: number,
  entry: string,
): number => {
  const record = lineOf(state, trackId, entry);
  if (!record) return 0;
  const total = Number(duration) > 0 ? Number(duration) : Number(record.duration) || 0;
  if (!(total >= RESUME_MIN_DURATION_SEC)) return 0;
  const position = Number(record.position) || 0;
  if (position <= RESUME_REWIND_SEC) return 0;
  return Math.max(0, Math.round(position - RESUME_REWIND_SEC));
};

const moveToFront = (state: ResumeState, scope: PlayerState['resumeScopes'][number]): void => {
  const index = state.resumeScopes.indexOf(scope);
  if (index < 0) return;
  state.resumeScopes.splice(index, 1);
  state.resumeScopes.unshift(scope);
};

export const rememberResumePosition = (
  state: ResumeState,
  trackId: string,
  position: number,
  duration: number,
  entry: string,
  meta?: { title?: string },
): void => {
  const key = toKey(trackId);
  if (!key) return;
  upgradeLegacyPositions(state);
  const line = entryKey(entry);
  dropStaleSingle(state, key);
  pruneEmptyScopes(state);
  const total = Number(duration) || 0;
  if (!(total >= RESUME_MIN_DURATION_SEC)) {
    // 太短不记：只丢这一条线，同一首在别的卡上的进度不动
    dropLine(state, key, line);
    pruneUnreferenced(state);
    return;
  }
  const safePosition = Math.max(0, Math.min(total, Number(position) || 0));
  if (safePosition < 1) return;
  const lines = linesOf(state, key);
  const previous = lines[line];
  const unchanged =
    previous &&
    Math.abs(previous.position - safePosition) < 3 &&
    Math.abs(previous.duration - total) < 1;
  if (!unchanged) {
    lines[line] = {
      position: Math.round(safePosition),
      duration: Math.round(total),
      updatedAt: touch(),
      entry,
    };
  }
  const title = String(meta?.title ?? '').trim();
  const stored = lines[line];
  if (stored && title && stored.title !== title) stored.title = title;

  const parsed = parseScopeEntry(entry);
  if (parsed) {
    // 单向：有声桶出现时清掉同 id 的专辑桶（一本书不该有两张续播卡）；
    // 反过来不清 —— 专辑可能整张在听，不能因为它顺带被记一次就抹掉有声进度。
    if (parsed.kind === 'audiobook') {
      const siblingKind = 'album';
      for (let index = state.resumeScopes.length - 1; index >= 0; index -= 1) {
        const sibling = state.resumeScopes[index];
        if (sibling && sibling.kind === siblingKind && sibling.id === parsed.id) {
          if (sibling.trackId && sibling.trackId !== key) {
            dropLine(state, sibling.trackId, scopeEntry(sibling.kind, sibling.id));
          }
          state.resumeScopes.splice(index, 1);
        }
      }
    }
    const scope = findScope(state, parsed.kind, parsed.id);
    const cached = readMeta(metaKey(parsed.kind, parsed.id));
    if (scope) {
      scope.trackId = key;
      scope.updatedAt = touch();
      // 歌单桶的 collection 串只在页面打开时知道，补到桶上，历史页收藏/跳转都靠它。
      if (cached?.routeId && scope.routeId !== cached.routeId) scope.routeId = cached.routeId;
      if (cached?.routeType && scope.routeType !== cached.routeType)
        scope.routeType = cached.routeType;
      moveToFront(state, scope);
      trimKind(state, parsed.kind);
    } else {
      state.resumeScopes.unshift({
        kind: parsed.kind,
        id: parsed.id,
        name: cached?.name ?? '',
        cover: cached?.cover ?? '',
        trackId: key,
        updatedAt: touch(),
        ...(cached?.routeId ? { routeId: cached.routeId } : {}),
        ...(cached?.routeType ? { routeType: cached.routeType } : {}),
      });
      trimKind(state, parsed.kind);
    }
  }
  pruneUnreferenced(state);
};

/**
 * 续播记录跟播放历史共用一份容量：历史里已经没有的曲目，它的进度记录和对应的桶一起清掉。
 * 历史被淘汰（超过上限）、手动删除、清空历史、刷新页面重新水合之后都会调用。
 */
export const pruneResumeAgainstHistory = (
  state: ResumeState,
  validTrackIds: ReadonlySet<string>,
): void => {
  upgradeLegacyPositions(state);
  const stale = Object.keys(state.resumePositions).filter((trackId) => !validTrackIds.has(trackId));
  if (!stale.length) return;
  // 历史里已经没有这首了：它的所有记录线一起丢（这条规则本来就按曲目算，与记录线无关）。
  for (const trackId of stale) dropTrack(state, trackId);
  // 桶自己那条线没了才清指针，别的线还在不算：pruneEmptyScopes 会把真正的空桶收走。
  state.resumeScopes.forEach((scope) => {
    const trackId = toKey(scope.trackId);
    if (!trackId) return;
    if (!lineOf(state, trackId, scopeEntry(scope.kind, scope.id))) scope.trackId = '';
  });
  pruneEmptyScopes(state);
};

/** 一本书只会是「专辑」或「有声」之一：同 id 出现两个桶时，只留记录线还对得上的那个（否则留较新）。 */
export const dedupeAlbumAudiobookScopes = (state: ResumeState): void => {
  const byId = new Map<string, PlayerState['resumeScopes']>();
  for (const scope of state.resumeScopes) {
    if (scope.kind !== 'album' && scope.kind !== 'audiobook') continue;
    const list = byId.get(scope.id) ?? [];
    list.push(scope);
    byId.set(scope.id, list);
  }
  upgradeLegacyPositions(state);
  for (const [id, scopes] of byId) {
    if (scopes.length < 2) continue;
    const alive = scopes.filter((scope) => {
      const trackId = toKey(scope.trackId);
      if (!trackId) return false;
      return Boolean(lineOf(state, trackId, scopeEntry(scope.kind, id)));
    });
    const keep = alive[0] ?? scopes[0];
    for (const scope of scopes) {
      if (scope === keep) continue;
      if (scope.trackId && scope.trackId !== keep.trackId) {
        dropLine(state, scope.trackId, scopeEntry(scope.kind, id));
      }
      const index = state.resumeScopes.indexOf(scope);
      if (index >= 0) state.resumeScopes.splice(index, 1);
    }
  }
  pruneUnreferenced(state);
};

/** 展示层用：某首曲目「最近写过的那条线」的进度（曲目列表里的「上次听到 x:xx」）。 */
export const resumeRecordOfTrack = (
  state: ResumeState,
  trackId: string,
): ResumePosition | undefined => newestLineOf(state, trackId);

/** 展示层用：某张续播卡自己那条记录线的进度——卡在，它的线就在，不会读到别的卡的进度。 */
export const resumeRecordForScope = (
  state: ResumeState,
  scope: { kind: ResumeScopeKind; id: string; trackId?: string } | null | undefined,
): ResumePosition | undefined => {
  if (!scope) return undefined;
  const trackId = toKey(scope.trackId);
  if (!trackId) return undefined;
  return lineOf(state, trackId, scopeEntry(scope.kind, scope.id));
};

/** 展示层用：每首曲目最近一条线的进度，供「没有桶时按曲目找上次听到」这类兜底用。 */
export const resumeTrackRecords = (
  state: ResumeState,
): { trackId: string; record: ResumePosition }[] => {
  const items: { trackId: string; record: ResumePosition }[] = [];
  for (const trackId of Object.keys(state.resumePositions)) {
    const record = newestLineOf(state, trackId);
    if (record) items.push({ trackId, record });
  }
  return items;
};
