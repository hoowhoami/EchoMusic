import type { Song } from '@/models/song';

/** 播放生命周期事件名 */
export type PlayerEventName =
  | 'trackchange'
  | 'play'
  | 'pause'
  | 'ended'
  | 'seek'
  | 'error'
  | 'timeupdate';

/** 播放事件统一负载，携带当前播放状态快照，订阅方无需再单独查询 */
export interface PlayerEventPayload {
  /** 事件名 */
  event: PlayerEventName;
  /** 当前曲目快照（可能为空） */
  track: Song | null;
  /** 当前曲目 id（可能为空） */
  trackId: string | null;
  /** 当前播放进度（秒） */
  currentTime: number;
  /** 当前曲目时长（秒） */
  duration: number;
  /** 是否正在播放 */
  isPlaying: boolean;
  /** error 事件的错误码，仅 error 事件存在 */
  error?: string;
}

export type PlayerEventHandler = (payload: PlayerEventPayload) => void;

export interface PlayerEventBus {
  /** 订阅事件，返回退订函数 */
  on: (event: PlayerEventName, handler: PlayerEventHandler) => () => void;
  /** 派发事件 */
  emit: (event: PlayerEventName, payload: PlayerEventPayload) => void;
}

/**
 * 创建播放生命周期事件总线。
 * 随 player store 单例创建，从 App 启动到退出全程存活，不依赖任何视图挂载或插件加载。
 */
export const createPlayerEventBus = (): PlayerEventBus => {
  const handlers = new Map<PlayerEventName, Set<PlayerEventHandler>>();

  const on = (event: PlayerEventName, handler: PlayerEventHandler): (() => void) => {
    let set = handlers.get(event);
    if (!set) {
      set = new Set();
      handlers.set(event, set);
    }
    set.add(handler);
    return () => {
      handlers.get(event)?.delete(handler);
    };
  };

  const emit = (event: PlayerEventName, payload: PlayerEventPayload) => {
    const set = handlers.get(event);
    if (!set || set.size === 0) return;
    // 复制一份，避免回调内退订导致迭代异常；单个 handler 抛错不影响其它订阅方
    for (const handler of Array.from(set)) {
      try {
        handler(payload);
      } catch (error) {
        console.error(`[player-events] 事件 "${event}" 的处理器执行异常`, error);
      }
    }
  };

  return { on, emit };
};
