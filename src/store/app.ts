import { dfid } from '@/api';
import { defineStore } from 'pinia';

interface App {
  dfid?: string;
}

export const useAppStore = defineStore('app', {
  persist: true,
  state: (): App => ({
    dfid: undefined,
  }),
  getters: {
    hasDfid(state) {
      return !!state?.dfid;
    },
  },
  actions: {
    setAppInfo(app: App) {
      this.$patch(app);
    },
    clearAppInfo() {
      this.$reset();
    },
    async initDfid() {
      if (this.hasDfid) {
        return;
      }
      this.dfid = undefined;
      const dfidResult = await dfid();
      this.setAppInfo({
        dfid: dfidResult.dfid,
      });
    },
  },
});
