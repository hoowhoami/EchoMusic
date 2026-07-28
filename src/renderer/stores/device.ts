import { defineStore } from 'pinia';

export interface DeviceInfo {
  dfid?: string;
  mid?: string;
  uuid?: string;
  guid?: string;
  serverDev?: string;
  mac?: string;
}

export const useDeviceStore = defineStore('device', {
  state: () => ({
    info: null as DeviceInfo | null,
  }),
  actions: {
    setDeviceInfo(info: DeviceInfo) {
      this.info = info;
    },
    clearDeviceInfo() {
      this.info = null;
    },
  },
  persist: true,
});
