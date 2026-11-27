import { ref } from 'vue';

/**
 * 写真皮肤（portrait）歌词当前是否收起。
 *
 * 主窗口的写真皮肤是唯一写入方，主进程把它随外观快照广播出去；
 * 动态壁纸窗口只是照着渲染，这样桌面壁纸上的展开/收起与播放页保持一致。
 */
export const portraitLyricCollapsed = ref(false);
