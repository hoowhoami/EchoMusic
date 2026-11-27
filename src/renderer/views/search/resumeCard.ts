export type ResumeCardKind = 'audiobook' | 'album' | 'artist' | 'playlist';

/** 搜索页右上角「上次播放」卡片的数据形状（全部来自本地续播桶，不发请求）。 */
export interface ResumeEntryCard {
  key: string;
  kind: ResumeCardKind;
  id: string;
  kindLabel: string;
  name: string;
  cover: string;
  /** 这条记录最后一次更新的时间（epoch ms），卡片按它倒序排列。 */
  updatedAt: number;
  /** 「上次听到 07:12」或「还没播放过」。 */
  hint: string;
  /** 歌单卡片专用：路由里的 collection 串与 type（桶 id 是歌单自己的数字 id）。 */
  routeId?: string;
  routeType?: string;
}
