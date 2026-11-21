import { reactive } from 'vue';
import type { RouteLocationRaw, Router } from 'vue-router';
import type { Song } from '@/models/song';

/** 卡片展示时长（默认值）：到点自己收起，不打断播放。设置页可改。 */
export const RESUME_HINT_VISIBLE_MS = 10000;

/** 停留时长下限/上限（秒）：设置页的输入框与这里同一口径。 */
export const RESUME_HINT_MIN_SECS = 3;
export const RESUME_HINT_MAX_SECS = 60;

/** 三个开关 + 停留时长：由设置页统一灌进来，util 不直接依赖 store。 */
export interface ResumeHintConfig {
  /** 续播卡总开关：关掉后提示卡、详情页卡、搜索页牌堆都不再出现 */
  enabled: boolean;
  /** 播放时弹提示卡 */
  popup: boolean;
  /** 详情页贴常驻卡 */
  page: boolean;
  /** 停留时长（毫秒） */
  visibleMs: number;
}

const hintConfig: ResumeHintConfig = {
  enabled: true,
  popup: true,
  page: true,
  visibleMs: RESUME_HINT_VISIBLE_MS,
};

export const setResumeHintConfig = (patch: Partial<ResumeHintConfig>): void => {
  if (typeof patch.enabled === 'boolean') hintConfig.enabled = patch.enabled;
  // 总开关一关：已经贴在屏幕上的卡立刻收走，不留残影
  if (patch.enabled === false) {
    dismissResumeHint();
    return;
  }
  if (typeof patch.popup === 'boolean') hintConfig.popup = patch.popup;
  if (typeof patch.page === 'boolean') hintConfig.page = patch.page;
  if (typeof patch.visibleMs === 'number' && Number.isFinite(patch.visibleMs)) {
    hintConfig.visibleMs = Math.max(1000, Math.round(patch.visibleMs));
  }
  // 计时中改了时长：按新值重新计时
  if (resumeHintState.open && !resumeHintState.persistent && hideTimer) {
    clearHideTimer();
    hideTimer = setTimeout(dismissResumeHint, hintConfig.visibleMs);
  }
};

export const getResumeHintConfig = (): Readonly<ResumeHintConfig> => hintConfig;

/** 最多同时贴几张：跟搜索页牌堆同一个上限（一串歌手的歌能同时命中好几个桶）。 */
export const RESUME_HINT_MAX_CARDS = 7;

export interface ResumeScopeLike {
  kind?: string;
  id?: string | number | null;
  trackId?: string | number | null;
  name?: string;
  cover?: string;
}

export interface ResumeRecordLike {
  position?: number;
  title?: string;
}

export type ResumeHintKind = 'audiobook' | 'album' | 'artist' | 'playlist';

/** 一张卡：一个桶一次命中就是一张，命中几个桶就叠几张。 */
export interface ResumeHintCard {
  /** kind:id，同一间桶只出一张 */
  key: string;
  kind: ResumeHintKind;
  /** 卡头那行里的类型名（有声、专辑、歌手、歌单） */
  kindLabel: string;
  /** 桶 id：有声与专辑都是专辑 id；歌手是歌手 id；歌单是歌单 id */
  scopeId: string;
  /** 桶名 */
  scopeName: string;
  cover: string;
  recordTitle: string;
  recordPosition: number;
  sameTrack: boolean;
}

export interface ResumeHintState {
  open: boolean;
  /** 首张卡的 key：详情页拿它比对「点的是不是我这页那张卡」 */
  key: string;
  /** 每贴一次 +1：卡片按它重新挂载，做到「旧卡消失、新卡出现」。 */
  token: number;
  /** 详情页里那几张常驻卡：不自动收起，退出页面或开始播那一集才收。 */
  persistent: boolean;
  /** 命中几个桶就有几张，按「有声 → 专辑 → 歌手 → 歌单」排 */
  cards: ResumeHintCard[];
  /* ↓ 下面这几个是首张卡的镜像，给只关心「一张卡」的地方用（详情页、旧测试） */
  kindLabel: string;
  albumId: string;
  scopeName: string;
  cover: string;
  recordTitle: string;
  recordPosition: number;
  sameTrack: boolean;
}

const KIND_LABEL: Record<ResumeHintKind, string> = {
  audiobook: '有声',
  album: '专辑',
  artist: '歌手',
  playlist: '歌单',
};

export const resumeHintState = reactive<ResumeHintState>({
  open: false,
  key: '',
  token: 0,
  persistent: false,
  cards: [],
  kindLabel: '有声',
  albumId: '',
  scopeName: '',
  cover: '',
  recordTitle: '',
  recordPosition: 0,
  sameTrack: true,
});

let hideTimer: ReturnType<typeof setTimeout> | null = null;

const clearHideTimer = () => {
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
};

/** 把 cards 写进 state：首张卡同时镜像到那几个单值字段上 */
const applyCards = (cards: ResumeHintCard[]): void => {
  resumeHintState.cards = cards;
  const first = cards[0];
  resumeHintState.key = first?.key ?? '';
  resumeHintState.kindLabel = first?.kindLabel ?? '有声';
  resumeHintState.albumId = first?.scopeId ?? '';
  resumeHintState.scopeName = first?.scopeName ?? '';
  resumeHintState.cover = first?.cover ?? '';
  resumeHintState.recordTitle = first?.recordTitle ?? '';
  resumeHintState.recordPosition = first?.recordPosition ?? 0;
  resumeHintState.sameTrack = first?.sameTrack ?? true;
};

export const dismissResumeHint = (): void => {
  clearHideTimer();
  resumeHintState.open = false;
};

/** 展示计时的暂停/恢复：竖列表展开着的时候不能让它自己消失。 */
export const setResumeHintHeld = (held: boolean): void => {
  clearHideTimer();
  if (held || !resumeHintState.open || resumeHintState.persistent) return;
  hideTimer = setTimeout(dismissResumeHint, hintConfig.visibleMs);
};

/** 删掉一张卡（牌堆里右键删的）：剩下几张继续摆着，删空了就收起来。 */
export const dropResumeHintCard = (key: string): void => {
  const rest = resumeHintState.cards.filter((card) => card.key !== key);
  if (rest.length === resumeHintState.cards.length) return;
  applyCards(rest);
  if (!rest.length) {
    dismissResumeHint();
    return;
  }
  setResumeHintHeld(false);
};

const cardOf = (
  kind: ResumeHintKind,
  scope: ResumeScopeLike,
  record: ResumeRecordLike | undefined,
  sameTrack: boolean,
): ResumeHintCard | null => {
  const position = Number(record?.position ?? 0);
  // 桶里没有真实进度（只打开过详情页）不弹：卡片说的是「上次听到这里」
  if (!(position > 0)) return null;
  const scopeId = String(scope.id ?? '').trim();
  if (!scopeId) return null;
  return {
    key: kind + ':' + scopeId,
    kind,
    kindLabel: KIND_LABEL[kind],
    scopeId,
    scopeName: String(scope.name ?? ''),
    cover: String(scope.cover ?? ''),
    recordTitle: String(record?.title ?? ''),
    recordPosition: Math.floor(position),
    sameTrack,
  };
};

export interface ResumeHintContext {
  /** 当前播放队列 id：`queue:playlist:<歌单id>` 时才认歌单桶（队列不是它就不猜） */
  queueId?: string;
}

/**
 * 播放前瞄一眼：这一首命中了哪些桶的续播记录，就弹几张卡（最多 4 张）。
 * 判定口径：
 * - 有声桶、专辑桶：桶 id === 歌曲 albumId（两者同一个 id，只有 kind 不同）；
 * - 歌手桶：桶 id 命中歌曲自带的歌手 id；
 * - 歌单桶：当前播放队列就是这个歌单（歌本身查不出所属歌单，不猜）。
 * 只提示不拦播放：用户不点就继续播；点了才跳过去从记录位置接着听。
 */
export const maybeShowResumeHint = (
  song: Song | null | undefined,
  resumeScopes: ReadonlyArray<ResumeScopeLike> = [],
  readRecord?: (scope: ResumeScopeLike) => ResumeRecordLike | undefined,
  context: ResumeHintContext = {},
): number => {
  // 设置里关掉了「播放时提示续播」就一声不吭
  if (!hintConfig.enabled || !hintConfig.popup) return 0;
  if (!song) return 0;
  const cards: ResumeHintCard[] = [];
  const seen = new Set<string>();
  const take = (kind: ResumeHintKind, scope: ResumeScopeLike, sameTrack: boolean) => {
    if (cards.length >= RESUME_HINT_MAX_CARDS) return;
    const card = cardOf(kind, scope, readRecord?.(scope), sameTrack);
    if (!card || seen.has(card.key)) return;
    seen.add(card.key);
    cards.push(card);
  };

  const trackId = String(song.id ?? '');
  const isSameTrack = (scope: ResumeScopeLike) => String(scope.trackId ?? '') === trackId;
  const albumId = String(song.albumId ?? '').trim();
  const artistIds = new Set<string>();
  for (const artist of [...(song.artists ?? []), ...(song.singers ?? [])]) {
    const id = String(artist?.id ?? '').trim();
    if (id) artistIds.add(id);
  }
  const playlistId = String(context.queueId ?? '').startsWith('queue:playlist:')
    ? String(context.queueId).slice('queue:playlist:'.length)
    : '';

  for (const scope of resumeScopes) {
    const scopeId = String(scope.id ?? '').trim();
    if (!scopeId) continue;
    if (scope.kind === 'audiobook' && albumId && scopeId === albumId) {
      take('audiobook', scope, isSameTrack(scope));
    }
  }
  for (const scope of resumeScopes) {
    const scopeId = String(scope.id ?? '').trim();
    if (scope.kind === 'album' && albumId && scopeId === albumId) {
      take('album', scope, isSameTrack(scope));
    }
  }
  for (const scope of resumeScopes) {
    const scopeId = String(scope.id ?? '').trim();
    if (scope.kind === 'artist' && artistIds.has(scopeId)) {
      take('artist', scope, isSameTrack(scope));
    }
  }
  for (const scope of resumeScopes) {
    const scopeId = String(scope.id ?? '').trim();
    if (scope.kind === 'playlist' && playlistId && scopeId === playlistId) {
      take('playlist', scope, isSameTrack(scope));
    }
  }

  if (cards.length === 0) return 0;

  // 连着再触发一次就是「顶替」：旧卡先收掉、新的再出来（token 变一下让组件重新挂载），
  // 用户能明显看到提示又出现了；静默忽略会让他以为没生效。
  clearHideTimer();
  resumeHintState.token += 1;
  applyCards(cards);
  resumeHintState.persistent = false;
  resumeHintState.open = true;
  hideTimer = setTimeout(dismissResumeHint, hintConfig.visibleMs);
  return cards.length;
};

/**
 * 点卡、点行、点定位按钮都只发这一条请求：落地页自己滚到那一集、高亮，
 * 能不能接着播由请求来源决定，不再靠路由 query 传参。
 */
export const resumeHintRequest = reactive<{
  key: string;
  token: number;
  consumed: number;
}>({
  key: '',
  token: 0,
  consumed: 0,
});

/**
 * 发一条续播请求：落地页自己滚到那一集、高亮，要不要从上次的位置接着播
 * 由「定位后自动续播」开关决定，入口不再区分能不能播。
 */
export const requestResumeHintPlay = (cardKey?: string): void => {
  resumeHintRequest.key = cardKey || resumeHintState.key;
  resumeHintRequest.token += 1;
};

/**
 * 落地页来取这条请求：只有「还没被取走」且 key 就是本页那张卡时才认领，
 * 认领后标记为已消费，避免缓存页反复定位。
 */
export const takeResumeHintRequest = (pageKey: string): boolean => {
  if (!pageKey) return false;
  if (!resumeHintRequest.token) return false;
  if (resumeHintRequest.consumed === resumeHintRequest.token) return false;
  if (resumeHintRequest.key !== pageKey) return false;
  resumeHintRequest.consumed = resumeHintRequest.token;
  return true;
};

/** 点续播卡后没能落到目标页时的提示语 */
export const RESUME_LOCATE_FAILED_TEXT = '定位续播记录失败，请稍后重试';

/**
 * 跳到续播目标页：跳转被拒、落到的不是这一页都算没跳成，
 * 调用方据此提示；目标和页面名、id 都对上才算成功。
 */
export const navigateResumeTarget = async (
  router: Router,
  target: RouteLocationRaw,
  expectedName: string,
  expectedId: string,
): Promise<boolean> => {
  try {
    await router.push(target);
  } catch {
    return false;
  }
  const route = router.currentRoute.value;
  return route.name === expectedName && String(route.params?.id ?? '') === String(expectedId);
};

export interface PageResumeHintInput {
  kind: ResumeHintKind;
  id: string;
  scopeName?: string;
  cover?: string;
  recordTitle?: string;
  recordPosition: number;
  trackId?: string | number | null;
  /** 现在正在播的就是记录里那一集 */
  sameTrack?: boolean;
}

/**
 * 详情页常驻续播卡：进页面时这一页有 position > 0 的续播记录就贴出来，不自动收起；
 * 退出页面、或者开始播记录里那一集时才收。
 */
export const showPageResumeHint = (input: PageResumeHintInput): void => {
  // 设置里关掉了「详情页续播卡」就不贴
  if (!hintConfig.enabled || !hintConfig.page) return;
  const id = String(input.id ?? '').trim();
  const position = Number(input.recordPosition ?? 0);
  if (!id || !(position > 0)) return;
  clearHideTimer();
  resumeHintState.token += 1;
  applyCards([
    {
      key: input.kind + ':' + id,
      kind: input.kind,
      kindLabel: KIND_LABEL[input.kind],
      scopeId: id,
      scopeName: String(input.scopeName ?? ''),
      cover: String(input.cover ?? ''),
      recordTitle: String(input.recordTitle ?? ''),
      recordPosition: Math.floor(position),
      sameTrack: input.sameTrack === true,
    },
  ]);
  resumeHintState.persistent = true;
  resumeHintState.open = true;
};
