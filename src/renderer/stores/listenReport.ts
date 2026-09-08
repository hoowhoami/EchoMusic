import { defineStore } from 'pinia';

/**
 * 听歌时长上报状态（sqlitePersist 持久化）
 *
 * 语义约定：
 *  - dSec        本地已确认的累计听歌秒数
 *  - pendingDiff 旧版本兼容字段，CSCC 接入后清零，不重放无曲目信息的历史增量
 *  - lastReportAt 上次成功发送播放事件的时间戳
 */
export const useListenReportStore = defineStore('listenReport', {
  state: () => ({
    dSec: 0,
    pendingDiff: 0,
    lastReportAt: 0,
  }),
  actions: {
    /** 退出登录/切换账号时清空，避免跨账号串号 */
    reset() {
      this.dSec = 0;
      this.pendingDiff = 0;
      this.lastReportAt = 0;
    },
  },
  persist: true,
});
