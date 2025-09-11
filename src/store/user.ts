import {
  addPlaylist,
  deletePlaylist,
  dfid,
  followSinger,
  getPlaylist,
  getUserFollow,
  unfollowSinger,
  userDetail,
  userVipDetail,
} from '@/api';
import type { Playlist, Singer, VipReceive } from '@/types';
import { isToday } from '@/utils';
import { isArray } from 'lodash-es';
import { defineStore } from 'pinia';

interface User {
  userid?: number;
  token?: string;
  username?: string;
  nickname?: string;
  pic?: string;
  // 扩展信息
  extends?: any;
  // 用户创建或收藏的歌单
  playlist?: Playlist[];
  // 用户关注的歌手
  follow?: Singer[];
  // VIP领取
  vipReceive?: VipReceive;
  vipReceiveNextTime?: number;
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
    playlist: undefined,
    follow: undefined,
    vipReceive: undefined,
    vipReceiveNextTime: undefined,
  }),
  getters: {
    isAuthenticated(state) {
      return !!state.token && !!state.userid;
    },
    hasExtends(state) {
      return !!state.extends?.dfid && !!state.extends?.detail && !!state.extends?.vip;
    },
    getCreatedPlaylist(state) {
      return state.playlist?.filter(item => item.list_create_userid === state.userid) ?? [];
    },
    getDefaultPlaylist(state) {
      return (
        state.playlist?.filter(
          item =>
            item.list_create_userid === state.userid &&
            (item.name === '默认收藏' || item.name === '我喜欢'),
        ) ?? []
      );
    },
    getLikedPlaylist(state) {
      return (
        state.playlist?.filter(item => item.list_create_userid !== state.userid && !item.authors) ??
        []
      );
    },
    isUserPlaylist: state => (id: string) => {
      return (
        state.playlist
          ?.filter(item => item.list_create_userid === state.userid)
          ?.some(item => item.global_collection_id === id) ?? false
      );
    },
    isCreatedPlaylist: state => (id: string) => {
      return (
        state.playlist
          ?.filter(item => item.list_create_userid === state.userid)
          ?.some(item => item.list_create_gid === id) ?? false
      );
    },
    isDefaultPlaylist: state => (id: string) => {
      return (
        state.playlist
          ?.filter(
            item =>
              item.list_create_userid === state.userid &&
              (item.name === '默认收藏' || item.name === '我喜欢'),
          )
          ?.some(item => item.list_create_gid === id) ?? false
      );
    },
    isLikedPlaylist: state => (id: string) => {
      return (
        state.playlist
          ?.filter(item => item.list_create_userid !== state.userid && !item.authors)
          ?.some(item => item.list_create_gid === id) ?? false
      );
    },
    isFollowedSinger: state => (id: number) => {
      return state.follow?.some(item => item.singerid === id && item.source === 7) ?? false;
    },
    isVipReceiveCompleted(state) {
      if (!state.vipReceive) {
        return false;
      }
      return isToday(state.vipReceive.day) && state.vipReceive.remain === 0;
    },
  },
  actions: {
    setUserInfo(user: User) {
      this.$patch(user);
    },
    clearUserInfo() {
      this.$reset();
    },
    async fetchUserExtends() {
      if (!this.isAuthenticated) {
        return;
      }
      this.extends = undefined;
      const dfidResult = await dfid();
      this.setUserInfo({
        extends: {
          dfid: dfidResult.dfid,
        },
      });
      const detailResult = await userDetail();
      this.setUserInfo({
        extends: {
          detail: detailResult,
        },
      });
      const vipResult = await userVipDetail();
      this.setUserInfo({
        extends: {
          vip: vipResult,
        },
      });
    },
    async initUserExtends() {
      if (!this.isAuthenticated) {
        return;
      }
      if (this.hasExtends) {
        return;
      }
      await this.fetchUserExtends();
    },
    async fetchPlaylist() {
      if (!this.isAuthenticated) {
        return;
      }
      this.playlist = undefined;
      const res = await getPlaylist();
      const sortedInfo = res.info.sort((a: Playlist, b: Playlist) => {
        if (a.sort !== b.sort) {
          return a.sort - b.sort;
        }
        return 0;
      });
      this.playlist = sortedInfo;
    },
    async createPlaylist(name: string, isPrivate: boolean = false) {
      await addPlaylist({
        name,
        is_pri: isPrivate ? 1 : 0,
        list_create_userid: this.userid,
      });
      await this.fetchPlaylist();
    },
    async deletePlaylist(id: number) {
      await deletePlaylist(id);
      await this.fetchPlaylist();
    },
    async likePlaylist(playlist: Playlist) {
      await addPlaylist({
        name: playlist.name,
        type: 1,
        list_create_listid: playlist.list_create_listid,
        list_create_userid: playlist.list_create_userid,
      });
      await this.fetchPlaylist();
    },
    async unlikePlaylist(id: number) {
      await deletePlaylist(id);
      await this.fetchPlaylist();
    },
    async fetchUserFollow() {
      if (!this.isAuthenticated) {
        return;
      }
      this.follow = undefined;
      const res = await getUserFollow();
      const lists = res?.lists;
      if (lists && !isArray(lists)) {
        return;
      }
      this.follow = res.lists;
    },
    async followSinger(id: number) {
      await followSinger(id);
      await this.fetchUserFollow();
    },
    async unfollowSinger(id: number) {
      await unfollowSinger(id);
      await this.fetchUserFollow();
    },
    setVipReceive(vipReceive: VipReceive) {
      const timestamp = new Date().getTime();
      vipReceive.day = timestamp;
      this.vipReceiveNextTime = timestamp + 10 * 60 * 1000;
      this.$patch({
        vipReceive,
      });
    },
    setVipReceiveCompleted() {
      this.$patch({
        vipReceive: {
          remain: 0,
          day: new Date().getTime(),
        },
      });
      this.vipReceiveNextTime = undefined;
    },
  },
});
