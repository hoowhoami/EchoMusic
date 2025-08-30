import type { PlayMode, Song } from '@/types';
import { defineStore } from 'pinia';

interface Player {
  loading: boolean;
  isPlaying: boolean;
  duration: number;
  progress: number;
  climax?: Record<string, string>; 
  playlist: Song[];
  originalPlaylist: Song[];
  current?: Song;
  index: number;
  currentTime: number;
  volume: number;
  mute: number;
  rate: number;
  mode: PlayMode;
  playlistShow: boolean;
}

export const usePlayerStore = defineStore('player', {
  persist: true,
  state: (): Player => ({
    loading: false,
    isPlaying: false,
    duration: 0,
    progress: 0,
    climax: undefined,
    playlist: [],
    originalPlaylist: [],
    current: undefined,
    index: -1,
    currentTime: 0,
    volume: 0.5,
    mute: 0,
    rate: 1,
    mode: 'repeat',
    playlistShow: false,
  }),
  getters: {},
  actions: {
    setPlaylist(playlist: Song[]) {
      this.playlist = playlist;
    },
    setNextPlaySong(song: Song, index: number): number {
      // 若为空,则直接添加
      if (this.playlist.length === 0) {
        this.playlist = [song];
        return 0;
      }
      // 在当前播放位置之后插入歌曲
      const indexAdd = index + 1;
      this.playlist.splice(indexAdd, 0, song);
      // 移除重复的歌曲（如果存在）
      const playList = this.playlist.filter((item, idx) => idx === indexAdd || item.hash !== song.hash);
      // 更新本地存储
      this.playlist = playList;
      // 返回刚刚插入的歌曲索引
      return playList.findIndex((item) => item.hash === song.hash);
    },
    setOriginalPlaylist(originalPlaylist: Song[]) {
      this.originalPlaylist = originalPlaylist;
    },
    clearOriginalPlaylist() {
      this.originalPlaylist = [];
    },
  },
});
