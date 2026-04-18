/* eslint-disable @typescript-eslint/no-require-imports */
import fs from 'fs';
import path from 'path';
import { app, ipcMain } from 'electron';
import log from 'electron-log';

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

  // 构建 cookie：默认值 + Authorization header 中的值
  const defaultCookies = buildDefaultCookies();
  const authCookies = parseAuthCookie(
    request.headers?.['Authorization'] || request.headers?.['authorization'],
  );
  const mergedCookies = { ...defaultCookies, ...authCookies };

  // 构建 query 参数（复现 Express 路由处理器的逻辑）
  const { cookie: paramCookie, ...restParams } = request.params || {};

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

    return {
      status: moduleResponse.status || 200,
      body: moduleResponse.body,
      cookie: moduleResponse.cookie,
      headers: moduleResponse.headers,
    };
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
}

/**
 * 获取 server 就绪状态
 */
export function isApiServerReady(): boolean {
  return serverReady;
}
