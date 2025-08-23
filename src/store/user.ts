import { defineStore } from 'pinia';

interface User {
  userid?: number;
  token?: string;
  username?: string;
  nickname?: string;
  avatar?: string;
}

export const useUserStore = defineStore('user', {
  persist: true,
  state: (): User => ({}),
  getters: {
    isAuthenticated(state) {
      return !!state.userid && !!state.token;
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
