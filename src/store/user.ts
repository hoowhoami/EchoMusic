import { defineStore } from 'pinia';

interface User {
  userid?: number;
  token?: string;
  username?: string;
  nickname?: string;
  pic?: string;
  status?: number;
}

export const useUserStore = defineStore('user', {
  persist: true,
  state: (): User => ({
    userid: undefined,
    token: undefined,
    username: undefined,
    nickname: undefined,
    pic: undefined,
    status: undefined,
  }),
  getters: {
    isAuthenticated(state) {
      return !!state.token && !!state.userid;
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
