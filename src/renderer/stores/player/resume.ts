import type { PlayerState, ResumePosition } from './state';
import type { PlayMode } from '../../types';
import { HISTORY_MAX_ENTRIES } from '@/utils/historyLimits';

/** 超过 30 秒的内容才记进度：太短的片段记了也没意义。 */
export const RESUME_MIN_DURATION_SEC = 30;
/** 接着播时往回倒 3 秒，免得正好卡在上一句结尾。 */
export const RESUME_REWIND_SEC = 3;
/** 每种详情页（有声/长专、专辑、歌手、歌单）最多记多少个：跟播放历史共用同一份容量上限。 */
export const RESUME_MAX_PER_KIND = HISTORY_MAX_ENTRIES;

export const RESUME_SINGLE_ENTRY = 'single';

export type ResumeScopeKind = 'audiobook' | 'album' | 'artist' | 'playlist';

/** 同一次播放命中多个桶时的优先级：有声/长专 > 歌手 > 专辑 > 歌单。 */
export const RESUME_SCOPE_PRIORITY: ResumeScopeKind[] = [
  'audiobook',
  'artist',
  'album',
  'playlist',
];

export const RESUME_SCOPE_LABEL: Record<ResumeScopeKind, string> = {
  audiobook: '有声/长专',
  album: '专辑',
  artist: '歌手',
  playlist: '歌单',
};

export type ResumeState = Pick<PlayerState, 'resumePositions' | 'resumeScopes'>;

export interface ResumeEntryContext {
  queueId?: string | null;
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

export const isScopeEntry = (entry: string): boolean => {
  const parsed = parseScopeEntry(entry);
  return parsed !== null;
};

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

/** 队列对应的详情页作用域（歌单 / 专辑 / 歌手）：桶已存在，或这个详情页刚被打开过（元数据已寄存）才算。 */
const resolveQueueScope = (
  state: ResumeState,
  queueId: unknown,
): { kind: ResumeScopeKind; id: string } | null => {
  const key = toKey(queueId);
  if (!key) return null;
  const pick = (
    kind: ResumeScopeKind,
    id: string,
  ): { kind: ResumeScopeKind; id: string } | null => {
    if (!id) return null;
    const known = findScope(state, kind, id) !== null || readMeta(metaKey(kind, id)) !== undefined;
    return known ? { kind, id } : null;
  };
  if (key.startsWith('queue:album:')) {
    const id = key.slice('queue:album:'.length).trim();
    if (!id) return null;
    return pick('audiobook', id) ?? pick('album', id);
  }
  if (key.startsWith('queue:artist:'))
    return pick('artist', key.slice('queue:artist:'.length).trim());
  if (key.startsWith('queue:playlist:'))
    return pick('playlist', key.slice('queue:playlist:'.length).trim());
  return null;
};

/** 这次播放算在哪条记录线上：正在播的列表自己就是一个详情页时优先算它，否则按专辑回落到专辑桶，最后才是单曲。 */
/** 队列是这一页的还不够，正在播的这首必须真的属于它：有声/长专章节、专辑曲目的 albumId 就是它。 */
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
  if (context.playMode !== 'random') {
    const queueScope = resolveQueueScope(state, context.queueId);
    if (queueScope && scopeOwnsTrack(queueScope, context.albumId)) {
      return scopeEntry(queueScope.kind, queueScope.id);
    }
  }
  // 已经由某个桶认领的曲目（先播后进详情页时会认领）继续留在那个桶里，
  // 否则下次保存又会退回单曲，桶里那条记录就成了没人维护的孤儿。
  const ownerTrackId = toKey(context.trackId);
  if (ownerTrackId) {
    const owner = state.resumeScopes.find(
      (scope) => scope.trackId === ownerTrackId && scopeOwnsTrack(scope, context.albumId),
    );
    if (owner) return scopeEntry(owner.kind, owner.id);
  }
  // 只有「详情页自己的播放队列」才拥有桶：单曲播放（搜索、收藏、歌词搜索、歌词行双击…）一律记为单曲，
  // 哪怕这一首恰好属于某本书/某张专辑，也不能认领那个桶的记录线，否则卡片上原来的章节名会被顶掉。
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
  pruneUnreferenced(state);
};

/** 按 id 找桶条目，找不到返回 null（给详情页判断「这本书以前听过没有」）。 */
export const findResumeScope = (
  state: ResumeState,
  kind: ResumeScopeKind,
  id: string,
): PlayerState['resumeScopes'][number] | null => findScope(state, kind, toKey(id));

/** 一张专辑命中的所有桶（有声/长专 / 专辑），按优先级排好；用于单曲跳桶。 */
export const findResumeScopesForAlbum = (
  state: ResumeState,
  albumId: string,
): PlayerState['resumeScopes'] => {
  const key = toKey(albumId);
  if (!key) return [];
  const kinds: ResumeScopeKind[] = ['audiobook', 'album'];
  const hits: PlayerState['resumeScopes'] = [];
  kinds.forEach((kind) => {
    const scope = findScope(state, kind, key);
    if (scope) hits.push(scope);
  });
  return hits;
};

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
    // 一本书只会是「专辑」或「有声/长专」之一：同 id 出现另一种桶就清掉，避免一张书两张续播卡。
    if (parsed.kind === 'album' || parsed.kind === 'audiobook') {
      const siblingKind = parsed.kind === 'album' ? 'audiobook' : 'album';
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
 * 「先播了、再进详情页」也算：进页面时如果正在播的这一首属于本页，就把它认领到本页的记录线上。
 * 专辑 / 有声/长专要求这一首的 albumId 就是本页 id，歌手页不设限。
 */
export const adoptTrackIntoScope = (
  state: ResumeState,
  kind: ResumeScopeKind,
  id: string,
  track: { id?: string | number | null; albumId?: string | number | null } | null | undefined,
): boolean => {
  const scopeId = toKey(id);
  const trackId = toKey(track?.id);
  if (!scopeId || !trackId || !RESUME_SCOPE_PRIORITY.includes(kind)) return false;
  if (!scopeOwnsTrack({ kind, id: scopeId }, track?.albumId)) return false;
  // 这条曲目最近写过的线（单曲线也算）：把它整份搬进本页这条线，别处那条线保持原样。
  const record = newestLineOf(state, trackId);
  if (!record || !(record.position >= 1)) return false;
  const entry = scopeEntry(kind, scopeId);
  if (entryKey(record.entry) === entry) return false;
  rememberResumePosition(state, trackId, record.position, record.duration, entry, {
    title: record.title,
  });
  return true;
};

export const forgetResumePosition = (state: ResumeState, trackId: string): void => {
  const key = toKey(trackId);
  if (!key) return;
  upgradeLegacyPositions(state);
  dropTrack(state, key);
  state.resumeScopes.forEach((scope) => {
    if (scope.trackId === key) scope.trackId = '';
  });
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

/** 一本书只会是「专辑」或「有声/长专」之一：同 id 出现两个桶时，只留记录线还对得上的那个（否则留较新）。 */
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

/** 把某个桶的「当前那一首」直接改成指定曲目（点「否」时认领当前这首，进度往后记到这张卡）。 */
export const claimResumeScope = (
  state: ResumeState,
  kind: ResumeScopeKind,
  id: string,
  trackId: string,
): void => {
  const scopeId = toKey(id);
  const key = toKey(trackId);
  if (!scopeId || !key || !RESUME_SCOPE_PRIORITY.includes(kind)) return;
  upgradeLegacyPositions(state);
  const scope = state.resumeScopes.find((item) => item.kind === kind && item.id === scopeId);
  if (!scope) return;
  const entry = scopeEntry(kind, scopeId);
  if (scope.trackId && scope.trackId !== key) {
    // 只撤掉本桶在这首曲子上的那条线，别的卡在这首上的进度不动
    dropLine(state, scope.trackId, entry);
  }
  scope.trackId = key;
  scope.updatedAt = touch();
  // 认领后先种一条占位进度：真正的进度要等播放推进才写入，期间 pruneEmptyScopes
  // 会把这种「只有指针、没有记录」的桶当空桶清掉。占位 position=1 让它活到真进度落地。
  const existing = lineOf(state, key, entry);
  if (!existing) {
    const fallback = newestLineOf(state, key);
    linesOf(state, key)[entry] = {
      position: 1,
      duration: fallback?.duration ?? 0,
      updatedAt: touch(),
      entry,
      ...(fallback?.title ? { title: fallback.title } : {}),
    };
  }
  moveToFront(state, scope);
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
