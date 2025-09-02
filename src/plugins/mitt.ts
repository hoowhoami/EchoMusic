import mitt, { Emitter } from 'mitt';

// 1. 定义所有可能的事件类型及其 payload 类型
type Events = {
  // 歌单变化事件
  playlistChanged: void;
};

// 2. 定义事件名称常量（与 Events 类型对应）
export const EventNames = {
  PLAYLIST_CHANGED: 'playlistChanged' as const,
};

// 3. 创建类型安全的事件总线实例
export const eventBus: Emitter<Events> = mitt<Events>();

// 4. 导出类型（方便在组件中使用）
export type EventBus = typeof eventBus;
export type EventName = keyof Events;
