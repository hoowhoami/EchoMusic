import type {
  PluginServerInterceptOptions,
  PluginServerInterceptor,
  PluginServerMatcher,
  PluginServerRequest,
  PluginServerResponse,
} from '../../shared/plugins';

/**
 * 服务请求拦截器注册表与洋葱链执行器。
 *
 * 本模块是纯工具层：不 import 任何 plugins 运行时代码，不感知插件概念之外的逻辑。
 * 插件侧的能力校验、异常隔离（fail-open）在 plugins/runtime/serverIntercept.ts 完成后
 * 再把安全 handler 注册到这里。
 */

interface Registration {
  /** 单调递增的注册序号，同优先级时稳定排序 */
  seq: number;
  pluginId: string;
  name?: string;
  priority: number;
  match?: (request: PluginServerRequest) => boolean;
  handler: PluginServerInterceptor;
}

let seqSeed = 0;
let registrations: Registration[] = [];

const normalizeMatcher = (
  matcher: PluginServerMatcher | undefined,
): ((request: PluginServerRequest) => boolean) | undefined => {
  if (matcher === undefined) return undefined;
  if (typeof matcher === 'string') {
    const prefix = matcher;
    return (request) => request.url.startsWith(prefix);
  }
  if (matcher instanceof RegExp) {
    return (request) => matcher.test(request.url);
  }
  return matcher;
};

/**
 * 注册一个服务请求拦截器。返回注销函数。
 * 注册表采用不可变更新：在途请求持有的数组快照不受后续注册/卸载影响。
 */
export const registerServerInterceptor = (
  pluginId: string,
  handler: PluginServerInterceptor,
  options: PluginServerInterceptOptions = {},
): (() => void) => {
  const item: Registration = {
    seq: ++seqSeed,
    pluginId,
    name: options.name,
    priority: options.priority ?? 0,
    match: normalizeMatcher(options.match),
    handler,
  };
  registrations = [...registrations, item];
  return () => {
    registrations = registrations.filter((registration) => registration !== item);
  };
};

export const hasServerInterceptors = (): boolean => registrations.length > 0;

/**
 * 插件返回值是否可当作 HTTP 响应。只约束 status 是 100–599 的有限数字，
 * 不限制 4xx/5xx，也不要求 body/headers，避免卡住 Mock、错误页和重定向。
 */
export const isValidServerResponse = (value: unknown): value is PluginServerResponse => {
  if (!value || typeof value !== 'object') return false;
  const status = (value as PluginServerResponse).status;
  return typeof status === 'number' && Number.isFinite(status) && status >= 100 && status < 600;
};

/** 优先级降序、注册序号升序：高优先级在外层，同优先级先注册在外层 */
const sortedChain = (): Registration[] =>
  registrations.slice().sort((a, b) => b.priority - a.priority || a.seq - b.seq);

/**
 * 洋葱链执行：只有 match 命中的拦截器才会被进入，链尾调用真实发送器 sender。
 * 排序与链组成在请求开始时一次性冻结。
 */
export const runServerInterceptorChain = async (
  initial: PluginServerRequest,
  sender: (request: PluginServerRequest) => Promise<PluginServerResponse>,
): Promise<PluginServerResponse> => {
  const chain = sortedChain();

  const dispatch = (depth: number, request: PluginServerRequest): Promise<PluginServerResponse> => {
    // 逐层即时求值 match：外层改写 url/params 后，内层按新值重新判定是否命中
    let index = depth;
    while (index < chain.length && chain[index].match && !chain[index].match!(request)) {
      index++;
    }

    const current = chain[index];
    if (!current) return sender(request); // 链尾：真实出网

    let downstream: Promise<PluginServerResponse> | undefined;
    // next 幂等：首次调用真正向下传递并记住结果 Promise，之后重复调用返回同一个。
    // 1) fail-open 包装器在 catch 中可无脑 return next() 兜底，不会把 POST 发两遍；
    // 2) 插件误重复调用 next 也不会产生重复请求。
    // 重复调用时传入的 patch 会被忽略，始终以第一次调用为准。
    const next = (
      requestPatch?: Partial<Omit<PluginServerRequest, 'origin'>>,
    ): Promise<PluginServerResponse> => {
      downstream ??= Promise.resolve().then(() =>
        dispatch(
          index + 1,
          requestPatch
            ? {
                ...request,
                ...requestPatch,
                headers: { ...request.headers, ...requestPatch.headers },
              }
            : request,
        ),
      );
      return downstream;
    };

    return Promise.resolve(current.handler(request, next)).then((result) => {
      if (isValidServerResponse(result)) {
        // 未调用 next 且返回了响应 = 短路接管，打上来源标记（插件显式设置优先）
        if (!downstream) {
          result.mocked ??= true;
          result.handledBy ??= current.pluginId;
        }
        return result;
      }
      return next(); // 返回非法值：兜底透传
    });
  };

  return dispatch(0, initial);
};

// --- 请求来源标记（防递归） ---
//
// 拦截器只处理 host 来源请求；插件经 ctx.kugou.* 发起的请求标记为 plugin 来源并绕过链。
// 业务 api 函数均在同步段发起 request.get/post（调用前无 await），因此用同步上下文标记即可，
// 无 AsyncLocalStorage 依赖、无并发竞态。

const HOST_ORIGIN: PluginServerRequest['origin'] = { type: 'host' };
let currentOrigin: PluginServerRequest['origin'] = HOST_ORIGIN;

export const runWithRequestOrigin = <T>(origin: PluginServerRequest['origin'], fn: () => T): T => {
  const previous = currentOrigin;
  currentOrigin = origin;
  try {
    return fn();
  } finally {
    // fn 同步返回 Promise 时立即恢复，不影响 await 期间的其它请求
    currentOrigin = previous;
  }
};

export const getCurrentRequestOrigin = (): PluginServerRequest['origin'] => currentOrigin;
