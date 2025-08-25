import { defineStore } from 'pinia';

interface User {
  userid?: number;
  token?: string;
  username?: string;
  nickname?: string;
  pic?: string;
  // 扩展信息
  extends?: any;
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
  }),
  getters: {
    isAuthenticated(state) {
      return !!state.token && !!state.userid;
    },
    hasExtends(state) {
      return !!state.extends;
    },
  },
  actions: {
    setUserInfo(user: User) {
      this.$patch(user);
    },
    clearUserInfo() {
      this.$reset();
    },
  },
});
