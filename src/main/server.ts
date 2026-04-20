/* eslint-disable @typescript-eslint/no-require-imports */
import fs from 'fs';
import path from 'path';
import { app, ipcMain } from 'electron';
import log from 'electron-log';
import { LRUCache } from './cache';

// --- 类型定义 ---

interface ModuleDefinition {
  identifier: string;
  route: string;
  module: (params: any, useAxios: any) => Promise<any>;
}

interface ApiRequest {
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

// --- 状态 ---

const isDev = !app.isPackaged;
let moduleMap: Map<string, ModuleDefinition> = new Map();
let serverReady = false;
let createRequestFn: ((config: any) => Promise<any>) | null = null;

// --- 缓存 ---
// TTL 30 分钟，最大 200 条，LRU 淘汰
const apiCache = new LRUCache(200, 30 * 60 * 1000);

// 不走缓存的路由（写操作、登录、轮询等）
const noCacheRoutes: string[] = [
  // 歌单写操作
  '/playlist/add',
  '/playlist/del',
  '/playlist/tracks/add',
  '/playlist/tracks/del',
  // 关注/取消关注
  '/artist/follow',
  '/artist/unfollow',
  // 播放历史上传
  '/playhistory/upload',
  // 登录相关
  '/login/qr/key',
  '/login/qr/create',
  '/login/qr/check',
  '/login/cellphone',
  '/login/wx/create',
  '/login/wx/check',
  '/login/openplat',
  '/captcha/sent',
  '/register/dev',
  // VIP 领取/升级
  '/youth/day/vip',
  '/youth/day/vip/upgrade',
  '/youth/vip',
];

// 写操作成功后，自动清除关联的读缓存（按路由前缀匹配）
const invalidationMap: Record<string, string[]> = {
  '/playlist/add': ['/user/playlist'],
  '/playlist/del': ['/user/playlist'],
  '/playlist/tracks/add': ['/playlist/track/all', '/playlist/track/all/new'],
  '/playlist/tracks/del': ['/playlist/track/all', '/playlist/track/all/new'],
  '/artist/follow': ['/user/follow'],
  '/artist/unfollow': ['/user/follow'],
  '/playhistory/upload': ['/user/history'],
  '/youth/day/vip': ['/user/vip/detail', '/youth/month/vip/record'],
  '/youth/day/vip/upgrade': ['/user/vip/detail', '/youth/month/vip/record'],
};

// server 内部使用的全局标识
let guid = '';
let serverDev = '';
let mid = '';

/**
 * 解析 server 目录路径
 */
const resolveServerPath = (): string => {
  if (isDev) {
    return path.join(process.cwd(), 'server');
  }
  return path.join(process.resourcesPath, 'server');
};

/**
 * 扫描并加载所有 server module
 * 复现 server/server.js 中 getModulesDefinitions 的逻辑
 */
const loadModules = (serverPath: string): ModuleDefinition[] => {
  const modulesPath = path.join(serverPath, 'module');
  const files = fs.readdirSync(modulesPath);

  return files
    .reverse()
    .filter((fileName) => fileName.endsWith('.js') && !fileName.startsWith('_'))
    .map((fileName) => {
      const identifier = fileName.split('.').shift() || fileName;
      const route = '/' + fileName.replace(/\.js$/i, '').replace(/_/g, '/');
      const modulePath = path.resolve(modulesPath, fileName);
      const mod = require(modulePath);
      return { identifier, route, module: mod };
    });
};

/**
 * 初始化 server 环境
 * 复现 server/server.js 中的全局变量初始化和环境变量设置
 */
export async function initApiServer(): Promise<void> {
  if (serverReady) return;

  const serverPath = resolveServerPath();

  // 设置环境变量，与 spawn 方式保持一致
  process.env.platform = 'lite';

  // 加载 .env（如果存在）
  const envPath = path.join(serverPath, '.env');
  if (fs.existsSync(envPath)) {
    try {
      const dotenv = require(path.join(serverPath, 'node_modules', 'dotenv'));
      dotenv.config({ path: envPath, quiet: true });
    } catch {
      // dotenv 不是必须的
    }
  }

  // 初始化 server 内部工具
  const utilPath = path.join(serverPath, 'util');
  const { cryptoMd5 } = require(path.join(utilPath, 'crypto'));
  const { getGuid, randomString, calculateMid } = require(path.join(utilPath, 'util'));
  const { createRequest } = require(path.join(utilPath, 'request'));
  const { applyCliOverrides } = require(path.join(utilPath, 'runtime'));

  // 应用 CLI 覆盖（设置 platform 等）
  applyCliOverrides(['--platform=lite']);

  // 生成全局标识（与 server/server.js 一致）
  guid = process.env.KUGOU_API_GUID || cryptoMd5(getGuid());
  serverDev = (process.env.KUGOU_API_DEV || randomString(10)).toUpperCase();
  mid = calculateMid(guid);

  createRequestFn = createRequest;

  // 加载所有 module
  const modules = loadModules(serverPath);
  moduleMap = new Map();
  for (const mod of modules) {
    moduleMap.set(mod.route, mod);
    log.info(`[IPC-Server] Route registered: ${mod.route}`);
  }

  serverReady = true;
  log.info(`[IPC-Server] Initialized, ${moduleMap.size} modules loaded`);
}

/**
 * 根据请求 URL 匹配 module
 * URL 格式如 /song/url → 匹配 route "/song/url"
 */
const matchModule = (url: string): ModuleDefinition | null => {
  // 去掉查询参数
  const pathname = url.split('?')[0];
  // 精确匹配
  if (moduleMap.has(pathname)) {
    return moduleMap.get(pathname)!;
  }
  // 尝试去掉尾部斜杠
  const normalized = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  if (moduleMap.has(normalized)) {
    return moduleMap.get(normalized)!;
  }
  return null;
};

/**
 * 从 Authorization header 解析 cookie 对象
 * 复现 server/server.js 中 authHeader → cookieToJson 的逻辑
 */
const parseAuthCookie = (authHeader?: string): Record<string, string> => {
  if (!authHeader) return {};
  const result: Record<string, string> = {};
  authHeader.split(';').forEach((pair) => {
    const eqIndex = pair.indexOf('=');
    if (eqIndex < 1) return;
    const key = pair.slice(0, eqIndex).trim();
    const value = pair.slice(eqIndex + 1).trim();
    if (key && value) result[key] = value;
  });
  return result;
};

/**
 * 构建默认 cookie（复现 Express 中间件的 ensureCookie 逻辑）
 */
const buildDefaultCookies = (): Record<string, string> => {
  return {
    KUGOU_API_PLATFORM: process.env.platform || 'lite',
    KUGOU_API_MID: mid,
    KUGOU_API_GUID: guid,
    KUGOU_API_DEV: serverDev,
    KUGOU_API_MAC: (process.env.KUGOU_API_MAC || '02:00:00:00:00:00').toUpperCase(),
  };
};

/**
 * 生成缓存 key：method + url + 排序后的 params
 */
const buildCacheKey = (method: string, url: string, params?: Record<string, any>): string => {
  const sortedParams = Object.entries(params || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return `${method}:${url}${sortedParams ? '?' + sortedParams : ''}`;
};

/**
 * 检查路由是否在不缓存列表中
 */
const isNoCacheRoute = (url: string): boolean => {
  const pathname = url.split('?')[0];
  return noCacheRoutes.includes(pathname);
};

/**
 * 根据写操作路由，清除关联的读缓存
 */
const invalidateRelatedCache = (url: string): void => {
  const pathname = url.split('?')[0];
  const relatedRoutes = invalidationMap[pathname];
  if (!relatedRoutes || relatedRoutes.length === 0) return;

  // 遍历缓存，删除所有匹配关联路由的条目
  const keysToDelete = apiCache.keys().filter((key) => {
    return relatedRoutes.some((route) => key.includes(route));
  });

  for (const key of keysToDelete) {
    apiCache.delete(key);
    log.info(`[Cache] AUTO-INVALIDATE: ${key} (triggered by ${pathname})`);
  }
};

/**
 * 处理 API 请求（核心路由分发逻辑）
 * 复现 server/server.js 中 Express 路由处理器的逻辑
 */
const handleApiRequest = async (request: ApiRequest): Promise<ApiResponse> => {
  if (!serverReady || !createRequestFn) {
    return { status: 503, body: { code: 503, msg: 'Service not ready' } };
  }

  const mod = matchModule(request.url);
  if (!mod) {
    return { status: 404, body: { code: 404, data: null, msg: 'Not Found' } };
  }

  // --- 缓存逻辑 ---
  const isGet = request.method === 'GET';
  const noCache = isNoCacheRoute(request.url);
  const cacheKey =
    isGet && !noCache ? buildCacheKey(request.method, request.url, request.params) : '';

  // 仅对 GET 且非 noCache 路由启用缓存
  if (isGet && !noCache) {
    const cached = apiCache.get(cacheKey);
    if (cached) {
      return cached;
    }
  }

  // 构建 cookie：默认值 + Authorization header 中的值
  const defaultCookies = buildDefaultCookies();
  const authCookies = parseAuthCookie(
    request.headers?.['Authorization'] || request.headers?.['authorization'],
  );
  const mergedCookies = { ...defaultCookies, ...authCookies };

  // 构建 query 参数（复现 Express 路由处理器的逻辑）
  // Express 中 query params 全部是 string 类型，IPC 传输保留了原始类型（number 等），
  // 部分 server module 依赖 .split() 等字符串方法，需要统一转为 string 以保持兼容
  const rawParams = request.params || {};
  const stringifiedParams: Record<string, any> = {};
  for (const [key, value] of Object.entries(rawParams)) {
    stringifiedParams[key] =
      value === null || value === undefined
        ? value
        : typeof value === 'object'
          ? value
          : String(value);
  }
  const { cookie: paramCookie, ...restParams } = stringifiedParams;

  // 合并 cookie：默认 cookie → param 中的 cookie → auth header 中的 cookie
  const cookieFromParams =
    typeof paramCookie === 'string' ? parseAuthCookie(paramCookie) : paramCookie || {};
  const finalCookie = { ...mergedCookies, ...cookieFromParams };

  const query: any = {
    cookie: finalCookie,
    ...restParams,
  };

  // 如果有 body 数据
  if (request.data) {
    query.body = request.data;
  }

  try {
    const moduleResponse = await mod.module(query, (config: any) => {
      // IPC 模式下没有真实 IP，传空即可
      config.ip = '';
      return createRequestFn!(config);
    });

    const response: ApiResponse = {
      status: moduleResponse.status || 200,
      body: moduleResponse.body,
      cookie: moduleResponse.cookie,
      headers: moduleResponse.headers,
    };

    // 成功的 GET 请求：可缓存路由写入缓存，不可缓存路由触发关联失效
    if (isGet && response.status < 400) {
      if (!noCache) {
        apiCache.set(cacheKey, response);
      } else {
        invalidateRelatedCache(request.url);
      }
    }

    return response;
  } catch (e: any) {
    const moduleResponse = e;

    if (!moduleResponse?.body) {
      return { status: 404, body: { code: 404, data: null, msg: 'Not Found' } };
    }

    return {
      status: moduleResponse.status || 502,
      body: moduleResponse.body,
      cookie: moduleResponse.cookie,
      headers: moduleResponse.headers,
    };
  }
};

/**
 * 注册 IPC handler
 */
export function registerApiIpcHandler(): void {
  ipcMain.handle('api:request', async (_event, request: ApiRequest): Promise<ApiResponse> => {
    return handleApiRequest(request);
  });

  // 清空 API 缓存（刷新按钮使用）
  ipcMain.handle('api:cache-clear', () => {
    const size = apiCache.size;
    apiCache.clear();
    log.info(`[Cache] CLEAR ALL: ${size} entries removed`);
    return { success: true };
  });
}

/**
 * 获取 server 就绪状态
 */
export function isApiServerReady(): boolean {
  return serverReady;
}
