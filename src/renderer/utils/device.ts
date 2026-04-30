import { registerDevice } from '@/api/user';
import { useDeviceStore, type DeviceInfo } from '@/stores/device';
import { logger } from './logger';

// 并发锁，防止多个请求同时触发注册
let registerPromise: Promise<void> | null = null;

/**
 * 从注册接口响应中提取设备信息
 */
export const extractDeviceInfo = (payload: unknown): DeviceInfo | null => {
  if (!payload || typeof payload !== 'object') return null;

  const record = payload as Record<string, unknown>;
  const data = record.data;
  if (!data || typeof data !== 'object') return null;

  const device = data as Record<string, unknown>;
  const dfid = typeof device.dfid === 'string' ? device.dfid : '';
  if (!dfid) return null;

  const deviceStore = useDeviceStore();
  return {
    ...deviceStore.info,
    dfid,
    mid: typeof device.mid === 'string' ? device.mid : deviceStore.info?.mid,
    uuid: typeof device.uuid === 'string' ? device.uuid : deviceStore.info?.uuid,
    guid: typeof device.guid === 'string' ? device.guid : deviceStore.info?.guid,
    serverDev:
      typeof device.serverDev === 'string' ? device.serverDev : deviceStore.info?.serverDev,
    mac: typeof device.mac === 'string' ? device.mac : deviceStore.info?.mac,
    appid: typeof device.appid === 'string' ? device.appid : deviceStore.info?.appid,
    clientver:
      typeof device.clientver === 'string' ? device.clientver : deviceStore.info?.clientver,
  };
};

/**
 * 确保设备已注册，dfid 不存在时自动调用注册接口
 * 带 Promise 锁防止并发重复注册
 */
export const ensureDevice = async () => {
  const deviceStore = useDeviceStore();
  if (deviceStore.info?.dfid) return;

  if (registerPromise) {
    await registerPromise;
    return;
  }

  registerPromise = (async () => {
    try {
      const response = await registerDevice();
      const info = extractDeviceInfo(response);
      if (info?.dfid) {
        deviceStore.setDeviceInfo(info);
        logger.info('Device', 'Device registered');
      } else {
        logger.warn('Device', 'Device register response invalid');
      }
    } catch (e) {
      logger.warn('Device', 'Device register failed', e);
    } finally {
      registerPromise = null;
    }
  })();

  await registerPromise;
};
