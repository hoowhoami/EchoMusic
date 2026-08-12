import { defineStore } from 'pinia';
import { getLoginDevices, kickLoginDevice } from '@/api/user';
import { useDeviceStore } from '@/stores/device';
import { ensureDevice } from '@/utils/device';
import logger from '@/utils/logger';

export interface LoginDeviceSession {
  id: string;
  title: string;
  platform: string;
  loginType: string;
  location: string;
  model: string;
  loginTime: string;
  activeTime: string;
  tMid: string;
  t: string;
  tAppid: string;
  tClientver: string;
  mid: string;
  dfid: string;
  uuid: string;
  isCurrent: boolean;
  isNew: boolean;
  canKick: boolean;
  raw: Record<string, unknown>;
}

type LoginDeviceApiRecord = {
  ver?: string | number;
  mid?: string | number;
  mt?: string | number;
  login_type?: string | number;
  new?: string | number;
  loc?: string;
  t?: string | number;
  app?: string;
  appid?: string | number;
  dev?: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readText = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  return String(value).trim();
};

const extractDeviceRecords = (payload: unknown): LoginDeviceApiRecord[] => {
  if (!isRecord(payload) || !isRecord(payload.data) || !Array.isArray(payload.data.li)) {
    return [];
  }
  return payload.data.li.filter(isRecord) as LoginDeviceApiRecord[];
};

const sortableTime = (device: LoginDeviceSession): number => {
  const value = Number(device.activeTime || device.loginTime || 0);
  return Number.isFinite(value) ? value : 0;
};

const normalizeSession = (
  raw: LoginDeviceApiRecord,
  index: number,
  currentMids: string[],
): LoginDeviceSession => {
  const mid = readText(raw.mid);
  const tMid = mid;
  const dfid = readText(raw.mt);
  const uuid = '';
  const t = readText(raw.t);
  const tAppid = readText(raw.appid);
  const tClientver = readText(raw.ver);
  const model = readText(raw.dev);
  const platform = readText(raw.app);
  const loginType = readText(raw.login_type);
  const location = readText(raw.loc);
  const loginTime = '';
  const activeTime = t;
  const newTime = readText(raw.new);
  const isNew = Boolean(newTime && newTime !== '0' && newTime === t);
  const title =
    model ||
    (platform.includes('安卓') || platform.toLowerCase().includes('android')
      ? '酷狗Android客户端'
      : platform) ||
    `登录设备 ${index + 1}`;
  const effectiveMid = tMid || mid;
  const isCurrent = Boolean(effectiveMid && currentMids.includes(effectiveMid));

  return {
    id: effectiveMid || dfid || uuid || `${title}-${index}`,
    title,
    platform,
    loginType,
    location,
    model,
    loginTime,
    activeTime,
    tMid,
    t,
    tAppid,
    tClientver,
    mid,
    dfid,
    uuid,
    isCurrent,
    isNew,
    canKick: Boolean(!isCurrent && tMid && t && tAppid && tClientver),
    raw: raw as Record<string, unknown>,
  };
};

export const useLoginDeviceStore = defineStore('loginDevices', {
  state: () => ({
    devices: [] as LoginDeviceSession[],
    loading: false,
    kickingId: '',
    loaded: false,
    error: '',
  }),
  getters: {
    currentDevice: (state) => state.devices.find((device) => device.isCurrent) || null,
  },
  actions: {
    async fetchDevices() {
      this.loading = true;
      this.error = '';
      this.devices = [];
      try {
        await ensureDevice();
        const response = await getLoginDevices();
        const currentMids = new Set<string>();
        const storeMid = useDeviceStore().info?.mid;
        if (storeMid) currentMids.add(storeMid);
        try {
          const identity = await window.electron.apiServer.identity();
          if (identity?.mid) currentMids.add(identity.mid);
        } catch {
          // main 进程身份读取失败时仅使用 renderer 持久化的 mid
        }
        this.devices = extractDeviceRecords(response)
          .map((record, index) => normalizeSession(record, index, Array.from(currentMids)))
          .sort((a, b) => {
            if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
            return sortableTime(b) - sortableTime(a);
          });
        this.loaded = true;
      } catch (error) {
        this.error = '登录设备获取失败';
        logger.warn('LoginDevices', 'Fetch login devices failed', error);
      } finally {
        this.loading = false;
      }
    },
    async kickDevice(device: LoginDeviceSession) {
      if (!device.canKick || device.isCurrent) return false;
      this.kickingId = device.id;
      this.error = '';
      try {
        await kickLoginDevice({
          t_mid: device.tMid,
          t: device.t,
          t_appid: device.tAppid,
          t_clientver: device.tClientver,
          mid: device.mid || device.tMid,
          dfid: device.dfid,
          uuid: device.uuid,
        });
        await this.fetchDevices();
        return true;
      } catch (error) {
        this.error = '设备移除失败';
        logger.warn('LoginDevices', 'Kick login device failed', error);
        return false;
      } finally {
        this.kickingId = '';
      }
    },
    reset() {
      this.devices = [];
      this.loading = false;
      this.kickingId = '';
      this.loaded = false;
      this.error = '';
    },
  },
});
