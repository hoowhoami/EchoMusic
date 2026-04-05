import { defineStore } from 'pinia';

interface SessionExpiredPayload {
  title: string;
  description: string;
}

const defaultSessionExpiredPayload = (): SessionExpiredPayload => ({
  title: '登录已过期',
  description: '您的登录信息已失效，为了您的账号安全，请重新登录。',
});

export const useAuthStore = defineStore('auth', {
  state: () => ({
    sessionExpiredDialogOpen: false,
    sessionExpiredPayload: defaultSessionExpiredPayload(),
  }),
  actions: {
    showSessionExpiredDialog(payload?: Partial<SessionExpiredPayload>) {
      this.sessionExpiredPayload = {
        ...defaultSessionExpiredPayload(),
        ...payload,
      };
      this.sessionExpiredDialogOpen = true;
    },
    hideSessionExpiredDialog() {
      this.sessionExpiredDialogOpen = false;
    },
  },
});
