import { useAuthStore } from '@/stores/auth';
import { useUserStore } from '@/stores/user';
import { useDeviceStore } from '@/stores/device';
import { logger } from './logger';
import { getPayloadSize, maskSensitiveText, stringifyForLog } from '../../shared/logging';
import { requestKugouVerification, type KugouVerificationChallenge } from './kugouVerification';

// --- 类型定义 ---

interface ApiRequestConfig {
  method: string;
  url: string;
  params?: Record<string, any>;
  data?: any;
  headers?: Record<string, string>;
}

interface ApiResponse {
  status: number;
  body: any;
  cookie?: string[];
  headers?: Record<string, string>;
}

interface RequestConfig {
  params?: Record<string, any>;
  data?: any;
  headers?: Record<string, string>;
  skipKugouVerification?: boolean;
}

interface InternalRequestOptions {
  retriedAfterKugouVerification?: boolean;
}

// --- 拦截器逻辑（从原 axios 版本保留） ---

let isAuthExpiredNotified = false;

const summarizeApiBody = (body: unknown): Record<string, unknown> => {
  if (!body || typeof body !== 'object') return { size: getPayloadSize(body) };
  const record = body as Record<string, unknown>;
  const data = record.data && typeof record.data === 'object' ? record.data : null;
  const dataRecord = data as Record<string, unknown> | null;
  const songs = Array.isArray(dataRecord?.songs) ? dataRecord.songs : null;
  const candidates = Array.isArray(dataRecord?.candidates ?? record.candidates)
    ? ((dataRecord?.candidates ?? record.candidates) as unknown[])
    : null;
  const list = Array.isArray(dataRecord?.list ?? record.list)
    ? ((dataRecord?.list ?? record.list) as unknown[])
    : null;

  return {
    status: record.status ?? dataRecord?.status,
    errorCode: record.error_code ?? dataRecord?.error_code,
    count: dataRecord?.count ?? record.count,
    songs: songs?.length,
    candidates: candidates?.length,
    list: list?.length,
    size: getPayloadSize(body),
  };
};

/**
 * 构建 Authorization header（复现原请求拦截器逻辑）
 */
export const buildAuthHeader = (skipAuth = false): string => {
  if (skipAuth) return '';

  const authParts: string[] = [];
  const userStore = useUserStore();
  const deviceStore = useDeviceStore();

  // 注入用户信息
  if (userStore.info) {
    if (userStore.info.token) authParts.push(`token=${userStore.info.token}`);
    if (userStore.info.userid) authParts.push(`userid=${userStore.info.userid}`);
    if (userStore.info.t1) authParts.push(`t1=${userStore.info.t1}`);
  }

  // 注入设备信息
  if (deviceStore.info) {
    const device = deviceStore.info;
    if (device.dfid) authParts.push(`dfid=${device.dfid}`);
    if (device.mid) authParts.push(`KUGOU_API_MID=${device.mid}`);
    if (device.uuid) authParts.push(`uuid=${device.uuid}`);
    if (device.guid) authParts.push(`KUGOU_API_GUID=${device.guid}`);
    if (device.serverDev) authParts.push(`KUGOU_API_DEV=${device.serverDev}`);
    if (device.mac) authParts.push(`KUGOU_API_MAC=${device.mac}`);
  }

  return authParts.join(';');
};

/**
 * 检查身份是否过期（复现原响应拦截器逻辑）
 */
const checkAuthExpiration = (path: string, data: any): boolean => {
  if (!data || typeof data !== 'object') return false;

  const rules = [
    () => Number(data.error_code) === 20018,
    () => data.msg && typeof data.msg === 'string' && data.msg.includes('登录已过期'),
  ];

  void path;
  return rules.some((rule) => rule());
};

const handleAuthExpired = (path: string, responseStatus: number, data: unknown) => {
  const userStore = useUserStore();

  // 仅在真实 IPC 失败（body 为 null）时跳过；上游业务错误（如 error_code 20018）
  // 在 server/util/request.js 中会被包装成 status=502，仍需基于 body 判定。
  if (responseStatus === 0) return;

  if (!userStore.isLoggedIn || isAuthExpiredNotified || !checkAuthExpiration(path, data)) {
    return;
  }

  isAuthExpiredNotified = true;
  logger.warn('API', `Auth expired (Path: ${path})`);
  // 不立即 logout，只弹窗让用户确认
  useAuthStore().showSessionExpiredDialog();

  window.setTimeout(() => {
    isAuthExpiredNotified = false;
  }, 5000);
};

const getKugouVerificationChallenge = (
  response: ApiResponse,
): KugouVerificationChallenge | null => {
  const body = response.body;
  const bodyRecord =
    body && typeof body === 'object' ? (body as Record<string, unknown>) : undefined;

  // sid/edt 不会在报错响应中返回，由服务端 /sidedt 在校验时模拟生成，这里只解析事件标识。
  const eventId =
    bodyRecord?.ssaCode || response.headers?.['ssa-code'] || response.headers?.['SSA-CODE'] || '';
  const normalizedEventId = String(eventId || '').trim();
  if (!normalizedEventId) return null;

  const errorCode = bodyRecord?.error_code;
  if (errorCode != null && Number(errorCode) !== 20028) return null;

  return {
    eventId: normalizedEventId,
  };
};

/**
 * 通过 IPC 发送 API 请求
 */
const ipcRequest = async (
  method: string,
  url: string,
  config?: RequestConfig,
  options?: InternalRequestOptions,
): Promise<any> => {
  const skipAuth = config?.headers?.['X-Skip-Auth'] === '1';
  const headers: Record<string, string> = { ...(config?.headers || {}) };
  delete headers['X-Skip-Auth'];
  const skipKugouVerification = Boolean(config?.skipKugouVerification);

  // 请求拦截：注入 Authorization
  const auth = buildAuthHeader(skipAuth);
  if (auth) {
    headers['Authorization'] = auth;
  }

  // 透传调用方的参数
  const params = {
    ...(config?.params || {}),
  };

  const ipcConfig: ApiRequestConfig = {
    method,
    url,
    params,
    headers,
  };

  if (config?.data) {
    ipcConfig.data = config.data;
  }

  const startTime = performance.now();
  let response: ApiResponse;
  let error: any = null;

  try {
    response = await window.electron.api.request(ipcConfig);
  } catch (e) {
    error = e;
    response = { status: 0, body: null };
  }

  const elapsed = (performance.now() - startTime).toFixed(1);

  const paramStr = Object.keys(params).length
    ? Object.entries(params)
        .map(([k, v]) => `${k}=${v}`)
        .join('&')
    : '';
  const fullUrl = maskSensitiveText(paramStr ? `${url}?${paramStr}` : url);

  if (error) {
    logger.error(
      'API',
      `[${method}] ${fullUrl}\n  ← ERROR (${elapsed}ms): ${error.message || error}`,
    );
    throw error;
  }

  const statusTag = response.status >= 400 ? '✗' : '✓';
  const headerEntries = Object.entries(headers).filter(([k]) => k !== 'Authorization');
  const bodySummary = summarizeApiBody(response.body);
  const baseLine = `${statusTag} [${method}] ${fullUrl} status=${response.status} time=${elapsed}ms summary=${stringifyForLog(
    bodySummary,
    600,
  )}`;

  if (response.status >= 400) {
    logger.warn('API', `${baseLine}\n  └─ Response: ${stringifyForLog(response.body, 800)}`);
  } else {
    logger.debug('API', baseLine);
    const shouldLogBody = logger.settings().apiResponseBody || logger.isEnabled('verbose');
    if (shouldLogBody) {
      const lines = [
        `${statusTag} [${method}] ${fullUrl}`,
        `  ├─ Auth: ${auth ? 'yes' : 'none'}`,
        ...(headerEntries.length
          ? [
              `  ├─ Headers: ${headerEntries
                .map(([k, v]) => `${k}: ${maskSensitiveText(String(v))}`)
                .join(', ')}`,
            ]
          : []),
        ...(config?.data ? [`  ├─ Body: ${stringifyForLog(config.data, 800)}`] : []),
        `  ├─ Status: ${response.status} | Time: ${elapsed}ms`,
        `  └─ Response: ${stringifyForLog(response.body, 2000)}`,
      ];
      if (logger.settings().apiResponseBody) {
        logger.info('API', lines.join('\n'));
      } else {
        logger.verbose('API', lines.join('\n'));
      }
    }
  }

  // 响应拦截：auth 过期检测
  handleAuthExpired(url, response.status, response.body);

  // 处理错误状态
  if (response.status >= 400) {
    const verifyChallenge = skipKugouVerification
      ? null
      : options?.retriedAfterKugouVerification
        ? null
        : getKugouVerificationChallenge(response);

    if (verifyChallenge) {
      logger.warn('API', `Kugou verification required (Path: ${url})`);
      await requestKugouVerification(verifyChallenge, (verifyUrl, verifyParams) =>
        ipcRequest('GET', verifyUrl, {
          params: verifyParams,
          skipKugouVerification: true,
        }),
      );
      logger.info('API', `Kugou verification passed, retrying ${url}`);
      return ipcRequest(method, url, config, { retriedAfterKugouVerification: true });
    }

    // 502 在本项目内是 server/util/request.js 的统一错误包装：
    // - 上游业务错误（body 含 error_code）：仅记录业务错误码
    // - 真实网关/网络失败（body 为 {status:0, msg:Error} 或 null）：保留网关告警
    if (response.status === 502) {
      const body = response.body as { error_code?: number | string } | null;
      const code = body?.error_code;
      if (code != null && Number(code) !== 0) {
        logger.warn('API', `Upstream business error (error_code=${code})`);
      } else {
        logger.error('API', 'Bad gateway (502)');
      }
    }
    const err = new Error(`API Error: ${response.status}`);
    (err as any).response = response;
    throw err;
  }

  return response.body;
};

// --- 对外暴露的接口（与原 axios 版本保持一致） ---

const request = {
  get: (url: string, config?: RequestConfig) => ipcRequest('GET', url, config),
  post: (url: string, data?: any, config?: RequestConfig) =>
    ipcRequest('POST', url, { ...config, data }),
};

export default request;
