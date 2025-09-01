import type { Playlist } from '@/types';
import { defineStore } from 'pinia';

interface User {
  userid?: number;
  token?: string;
  username?: string;
  nickname?: string;
  pic?: string;
  // 扩展信息
  extends?: any;
  // 创建歌单
  createdPlaylist?: Playlist[];
  // 收藏歌单
  likedPlaylist?: Playlist[];
}

export const useUserStore = defineStore('user', {
  persist: true,
  state: (): User => ({
    userid: undefined,
    token: undefined,
    username: undefined,
    nickname: undefined,
    pic: undefined,
    extends: undefined,
    likedPlaylist: undefined,
  }),
  getters: {
    isAuthenticated(state) {
      return !!state.token && !!state.userid;
    },
    hasExtends(state) {
      return !!state.extends?.dfid && !!state.extends?.detail && !!state.extends?.vip;
    },
    isLikedPlaylist: state => (id: string) => {
      return state.likedPlaylist?.some(item => item.list_create_gid === id);
    },
  },
  actions: {
    setUserInfo(user: User) {
      this.$patch(user);
    },
    clearUserInfo() {
      this.$reset();
    },
    setLikedPlaylist(playlist: Playlist[]) {
      this.likedPlaylist = playlist;
    },
  },
});
