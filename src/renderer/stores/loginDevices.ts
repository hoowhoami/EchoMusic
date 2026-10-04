import { defineStore } from 'pinia';
import { computed, ref, shallowRef, toRaw, watch } from 'vue';
import { useUserStore } from '@/stores/user';
import { captureUserSession } from '@/utils/userSession';
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

export const useLoginDeviceStore = defineStore('loginDevices', () => {
  const user = useUserStore();
  const devices = shallowRef<LoginDeviceSession[]>([]);
  const loading = ref(false);
  const kickingId = ref('');
  const loaded = ref(false);
  const error = ref('');
  const currentDevice = computed(() => devices.value.find((device) => device.isCurrent) || null);
  let generation = 0;
  let fetchSequence = 0;
  let fetchFlight: Promise<void> | null = null;
  let kickFlight: Promise<boolean> | null = null;
  const deviceGenerations = new WeakMap<object, number>();

  const reset = () => {
    generation += 1;
    fetchSequence += 1;
    fetchFlight = null;
    kickFlight = null;
    devices.value = [];
    loading.value = false;
    kickingId.value = '';
    loaded.value = false;
    error.value = '';
  };
  watch(
    [
      () => user.isLoggedIn,
      () => user.accountRevision,
      () => user.info?.userid ?? user.info?.userId,
      () => user.info?.token,
    ],
    reset,
    { flush: 'sync' },
  );

  const fetchDevices = (force = false): Promise<void> => {
    if (!user.isLoggedIn) return Promise.resolve();
    if (fetchFlight && !force) return fetchFlight;
    const requestGeneration = generation;
    const requestSequence = ++fetchSequence;
    const isCurrentSession = captureUserSession(user);
    const isCurrent = () =>
      requestGeneration === generation && requestSequence === fetchSequence && isCurrentSession();
    loading.value = true;
    error.value = '';
    const task = async () => {
      try {
        await ensureDevice();
        if (!isCurrent()) return;
        const response = await getLoginDevices();
        if (!isCurrent()) return;
        const records = extractDeviceRecords(response);
        const currentMids = new Set<string>();
        const storeMid = useDeviceStore().info?.mid;
        if (storeMid) currentMids.add(storeMid);
        try {
          const identity = await window.electron.apiServer.identity();
          if (identity?.mid) currentMids.add(identity.mid);
        } catch {
          // main 进程身份读取失败时仅使用 renderer 持久化的 mid
        }
        if (!isCurrent()) return;
        const next = records
          .map((record, index) => normalizeSession(record, index, Array.from(currentMids)))
          .sort((a, b) =>
            a.isCurrent !== b.isCurrent
              ? a.isCurrent
                ? -1
                : 1
              : sortableTime(b) - sortableTime(a),
          );
        next.forEach((device) => deviceGenerations.set(device, requestGeneration));
        devices.value = next;
        loaded.value = true;
      } catch (cause) {
        if (!isCurrent()) return;
        error.value = '登录设备获取失败';
        logger.warn('LoginDevices', 'Fetch login devices failed', cause);
      } finally {
        if (isCurrent()) loading.value = false;
      }
    };
    const flight = task().finally(() => {
      if (fetchFlight === flight) fetchFlight = null;
    });
    if (generation === requestGeneration) fetchFlight = flight;
    return flight;
  };

  const kickDevice = (device: LoginDeviceSession): Promise<boolean> => {
    if (
      !user.isLoggedIn ||
      !device.canKick ||
      device.isCurrent ||
      deviceGenerations.get(toRaw(device)) !== generation ||
      kickFlight
    )
      return Promise.resolve(false);
    const requestGeneration = generation;
    const isCurrentSession = captureUserSession(user);
    const isCurrent = () => requestGeneration === generation && isCurrentSession();
    kickingId.value = device.id;
    error.value = '';
    const task = async () => {
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
        if (!isCurrent()) return false;
        // 移除后必须刷新，不能复用移除前已在途的列表快照。
        await fetchDevices(true);
        return isCurrent();
      } catch (cause) {
        if (!isCurrent()) return false;
        error.value = '设备移除失败';
        logger.warn('LoginDevices', 'Kick login device failed', cause);
        return false;
      } finally {
        if (isCurrent()) kickingId.value = '';
      }
    };
    const flight = task().finally(() => {
      if (kickFlight === flight) kickFlight = null;
    });
    if (generation === requestGeneration) kickFlight = flight;
    return flight;
  };
  return {
    devices,
    loading,
    kickingId,
    loaded,
    error,
    currentDevice,
    fetchDevices,
    kickDevice,
    reset,
  };
});
