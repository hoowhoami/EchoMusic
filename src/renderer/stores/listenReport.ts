import { defineStore } from 'pinia';

/**
 * 听歌时长上报状态（sqlitePersist 持久化）
 *
 * 语义约定：
 *  - dSec        本地累计听歌秒数，仅服务端确认上报成功后递增（防重复计数/虚高）
 *  - pendingDiff 待上报增量秒数，上报失败保留、成功后清零，下次合并上报
 *  - lastReportAt 上次成功上报时间戳，用于控制上报频率（符合上游"按正常听歌节奏调用"约束）
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
