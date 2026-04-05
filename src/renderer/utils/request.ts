import axios from 'axios';
import { useAuthStore } from '@/stores/auth';
import { useUserStore } from '@/stores/user';
import { useDeviceStore } from '@/stores/device';
import { logger } from './logger';

const isDev = import.meta.env.DEV;
const API_BASE_URL = isDev ? '/api' : 'http://127.0.0.1:12306';

const request = axios.create({
  baseURL: API_BASE_URL,
  timeout: 10000,
  withCredentials: true,
});

let isAuthExpiredNotified = false;

// 请求拦截器
request.interceptors.request.use(
  (config) => {
    const skipAuth = config.headers?.['X-Skip-Auth'] === '1';

    if (config.headers?.['X-Skip-Auth']) {
      delete config.headers['X-Skip-Auth'];
    }

    const authParts: string[] = [];

    // 从 Pinia Store 中获取信息
    const userStore = useUserStore();
    const deviceStore = useDeviceStore();

    if (!skipAuth) {
      // 1. 注入用户信息
      if (userStore.info) {
        if (userStore.info.token) authParts.push(`token=${userStore.info.token}`);
        if (userStore.info.userid) authParts.push(`userid=${userStore.info.userid}`);
        if (userStore.info.t1) authParts.push(`t1=${userStore.info.t1}`);
      }

      // 2. 注入设备信息
      if (deviceStore.info) {
        const device = deviceStore.info;
        if (device.dfid) authParts.push(`dfid=${device.dfid}`);
        if (device.mid) authParts.push(`KUGOU_API_MID=${device.mid}`);
        if (device.uuid) authParts.push(`uuid=${device.uuid}`);
        if (device.guid) authParts.push(`KUGOU_API_GUID=${device.guid}`);
        if (device.serverDev) authParts.push(`KUGOU_API_DEV=${device.serverDev}`);
        if (device.mac) authParts.push(`KUGOU_API_MAC=${device.mac}`);
      }
    }

    const auth = authParts.join(';');
    if (authParts.length > 0) {
      config.headers['Authorization'] = auth;
    }

    config.params = {
      ...config.params,
      t: Date.now(),
    };

    // 打印请求日志
    const fullUrl = axios.getUri(config);
    logger.info(
      'API',
      `Request: [${config.method?.toUpperCase()}] ${fullUrl}`,
      auth ? `Auth: ${auth}` : '',
    );

    return config;
  },
  (error) => {
    logger.error('API', 'Request Error:', error);
    return Promise.reject(error);
  },
);

/**
 * 检查身份是否过期
 */
const checkAuthExpiration = (path: string, data: any) => {
  if (!data || typeof data !== 'object') return false;

  const rules = [
    // 规则 1: 全局错误码 20018 表示 token 过期
    () => data.error_code === 20018,
    // 规则 2: VIP 详情接口返回 status 为 0 通常表示 token 失效
    () => path.includes('/user/vip/detail') && data.status === 0,
    // 规则 3: 响应消息包含 "登录已过期"
    () => data.msg && typeof data.msg === 'string' && data.msg.includes('登录已过期'),
  ];

  return rules.some((rule) => rule());
};

const handleAuthExpired = (path: string, data: unknown) => {
  const userStore = useUserStore();

  if (!userStore.isLoggedIn || isAuthExpiredNotified || !checkAuthExpiration(path, data)) {
    return;
  }

  isAuthExpiredNotified = true;
  logger.warn('API', `检测到身份过期 (Path: ${path})`);
  userStore.logout();
  useAuthStore().showSessionExpiredDialog();

  window.setTimeout(() => {
    isAuthExpiredNotified = false;
  }, 5000);
};

// 响应拦截器
request.interceptors.response.use(
  (response) => {
    const data = response.data;
    const path = response.config.url || '';

    // 打印响应日志
    let resStr = typeof data === 'object' ? JSON.stringify(data) : String(data);
    if (resStr.length > 2000) {
      resStr = resStr.substring(0, 2000) + '... (truncated)';
    }
    logger.info('API', `Response: ${path} ->`, resStr);

    handleAuthExpired(path, data);

    return data;
  },
  (error) => {
    const config = error.config;

    if (error.response) {
      const { status, data } = error.response;
      const path = config?.url || '';
      logger.error('API', `Response Error [${status}]: ${path} ->`, data);

      // 处理 502 错误
      if (status === 502) {
        logger.error('API', '服务器网关错误 (502)');
      }

      handleAuthExpired(path, data);
    } else {
      logger.error('API', `Network Error: ${config?.url} ->`, error.message);
    }

    return Promise.reject(error);
  },
);

export default request;
