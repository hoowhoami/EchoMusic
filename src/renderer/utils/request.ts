import { useAuthStore } from '@/stores/auth';
import { useUserStore } from '@/stores/user';
import { useDeviceStore } from '@/stores/device';
import { logger } from './logger';
import {
  getCurrentRequestOrigin,
  hasServerInterceptors,
  runServerInterceptorChain,
} from './serverInterceptors';
import type { PluginServerRequest } from '../../shared/plugins';
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
  /** 拦截器短路（Mock/转发）标记 */
  mocked?: boolean;
  handledBy?: string;
}

interface RequestConfig {
  params?: Record<string, any>;
  data?: any;
  headers?: Record<string, string>;
  skipKugouVerification?: boolean;
}

interface InternalRequestOptions {
  retriedAfterKugouVerification?: boolean;
  /** 显式指定的请求来源；验证重试等异步续体必须传此值，不能依赖 ambient 标记 */
  origin?: PluginServerRequest['origin'];
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
    errorCode:
      record.error_code ??
      record.err_code ??
      record.errcode ??
      dataRecord?.error_code ??
      dataRecord?.errcode,
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

  // 这里只读取验证事件；服务端附加的 sid/edt 是模拟值，不是上游返回的凭证。
  const eventId =
    bodyRecord?.ssaCode ||
    response.headers?.['ssa-code'] ||
    response.headers?.['SSA-CODE'] ||
    (bodyRecord?.data as Record<string, unknown> | undefined)?.event_id ||
    '';
  const normalizedEventId = String(eventId || '').trim();
  if (!normalizedEventId) return null;

  const errorCode = Number(bodyRecord?.error_code ?? 0);
  const failed = Number(bodyRecord?.status ?? 0) === 0;
  if (errorCode !== 20028 && !failed) return null;

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
    const data = config.data;
    ipcConfig.data = Array.isArray(data)
      ? [...data]
      : data && typeof data === 'object' && Object.getPrototypeOf(data) === Object.prototype
        ? { ...data }
        : data;
  }

  const startTime = performance.now();
  let response: ApiResponse;
  let error: any = null;

  // 插件服务请求拦截链（主程序 → 插件拦截器 → server）：
  // 仅处理 host 来源请求；插件经 ctx.kugou 发起的请求标记为 plugin 来源，直接绕过链。
  // 拦截器可在 IPC 序列化之前修改 params/data/headers/url（主进程会基于新值重算签名），
  // 也可不调用 next 直接短路返回 Mock/转发响应。
  // 来源在同步入口段读取一次（此时 runWithRequestOrigin 的同步标记仍生效）；
  // 验证重试等异步续体经 options.origin 显式传递，避免读回宿主默认值把插件请求放进拦截链。
  const origin = options?.origin ?? getCurrentRequestOrigin();
  try {
    if (origin.type === 'host' && hasServerInterceptors()) {
      response = await runServerInterceptorChain(
        {
          method,
          url,
          // 传入宿主侧副本：插件直接原地修改 request.params/headers 不会污染
          // 本函数后续用于日志的局部变量（修改仍会随链正常传递给 sender）。
          params: { ...params },
          ...(ipcConfig.data !== undefined ? { data: ipcConfig.data } : {}),
          headers: { ...headers },
          origin,
        },
        (req) =>
          window.electron.api.request({
            method: req.method,
            url: req.url,
            params: req.params,
            headers: req.headers,
            ...(req.data !== undefined ? { data: req.data } : {}),
          }) as Promise<ApiResponse>,
      );
      if (response.mocked) {
        logger.debug(
          'API',
          `[${method}] ${maskSensitiveText(url)} short-circuited by plugin: ${response.handledBy ?? 'unknown'}`,
        );
      }
    } else {
      response = await window.electron.api.request(ipcConfig);
    }
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
    const requestBodyLine =
      config?.data !== undefined ? `\n  ├─ Body: ${stringifyForLog(config.data, 800)}` : '';
    logger.warn(
      'API',
      `${baseLine}${requestBodyLine}\n  └─ Response: ${stringifyForLog(response.body, 800)}`,
    );
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

  // 响应拦截：auth 过期检测。Mock 短路响应不是真实上游结果，不能据此弹登录过期。
  if (!response.mocked) {
    handleAuthExpired(url, response.status, response.body);
  }

  if (
    !skipKugouVerification &&
    options?.retriedAfterKugouVerification &&
    getKugouVerificationChallenge(response)
  ) {
    throw new Error('验证已完成，但酷狗仍拒绝本次操作，请稍后重试；输入内容已保留');
  }

  if (!skipKugouVerification && !options?.retriedAfterKugouVerification) {
    const verifyChallenge = getKugouVerificationChallenge(response);
    if (verifyChallenge) {
      logger.warn('API', `Kugou verification required (Path: ${url})`);
      await requestKugouVerification(verifyChallenge, (verifyUrl, verifyParams) =>
        ipcRequest('GET', verifyUrl, {
          params: verifyParams,
          skipKugouVerification: true,
        }),
      );
      logger.info('API', `Kugou verification passed, retrying ${url}`);
      // 重试沿用原始请求的来源：此处已处于异步续体，ambient 标记早已恢复为 host，
      // 显式透传可避免插件来源请求被放进拦截链。
      return ipcRequest(method, url, config, { retriedAfterKugouVerification: true, origin });
    }
  }

  // 处理错误状态
  if (response.status >= 400) {
    // 502 在本项目内是 server/util/request.js 的统一错误包装：
    // - 上游业务错误（body 含 error_code/errcode）：仅记录业务错误码
    // - 真实网关/网络失败（body 为 {status:0, msg:Error} 或 null）：保留网关告警
    if (response.status === 502) {
      const body = response.body as {
        error_code?: number | string;
        err_code?: number | string;
        errcode?: number | string;
      } | null;
      const code = body?.error_code ?? body?.err_code ?? body?.errcode;
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
