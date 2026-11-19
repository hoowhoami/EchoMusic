/** 续播记录（历史页四个 tab 与批量弹窗共用）。 */
export type ResumeKind = 'album' | 'audiobook' | 'artist' | 'playlist';

export interface ResumeRow {
  key: string;
  id: string;
  /** 桶里记着的那首曲目，定位当前播放时要靠它找到对应的行。 */
  trackId: string;
  name: string;
  cover: string;
  hint: string;
  position: number;
  duration: number;
  updatedAt: number;
  /** 歌单桶专用：路由里的 collection 串，详情接口只认它。 */
  routeId?: string;
  /** 歌单桶专用：路由上的 type（user / special / album）。 */
  routeType?: string;
}
