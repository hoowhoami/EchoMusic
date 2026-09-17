import type { EchoPluginDescriptor } from '../../shared/plugins';
import { runWithRequestOrigin } from '../utils/serverInterceptors';

type RuntimeApiModule = Record<string, unknown>;
type RuntimeApiFunction = (...args: unknown[]) => unknown;

export type PluginKugouApiMethod = (...args: unknown[]) => Promise<unknown>;
export type PluginKugouApiNamespace = {
  [apiName: string]: PluginKugouApiMethod;
};
export type PluginKugouApi = {
  [namespace: string]: PluginKugouApiNamespace;
};

type ApiModuleLoader = () => Promise<RuntimeApiModule>;

const apiModuleLoaders = Object.entries(import.meta.glob('../api/*.ts')).reduce<
  Record<string, ApiModuleLoader>
>((loaders, [path, loader]) => {
  const namespace = path.match(/\/([^/]+)\.ts$/)?.[1];
  if (!namespace || namespace === 'external') return loaders;
  loaders[namespace] = loader as ApiModuleLoader;
  return loaders;
}, {});

const apiModulePromises = new Map<string, Promise<RuntimeApiModule>>();
const skippedProxyProperties = new Set(['then', 'catch', 'finally', 'toJSON']);

const loadApiModule = (namespace: string) => {
  const loader = apiModuleLoaders[namespace];
  if (!loader) throw new Error(`酷狗 API 模块不存在: ${namespace}`);

  let promise = apiModulePromises.get(namespace);
  if (!promise) {
    promise = loader();
    apiModulePromises.set(namespace, promise);
  }
  return promise;
};

const loadApiFunction = async (namespace: string, functionName: string) => {
  const module = await loadApiModule(namespace);
  const api = module[functionName];

  if (typeof api !== 'function') {
    throw new Error(`酷狗 API 不存在: ${namespace}.${functionName}`);
  }

  return api as RuntimeApiFunction;
};

const requireKugouApiCapability = (descriptor: EchoPluginDescriptor) => {
  if (descriptor.manifest.capabilities?.kugouApi !== true) {
    throw new Error('插件未声明酷狗 API 能力');
  }
};

const createApiNamespace = (descriptor: EchoPluginDescriptor, namespace: string) =>
  new Proxy({} as PluginKugouApiNamespace, {
    get(target, property, receiver) {
      if (typeof property !== 'string') {
        return Reflect.get(target, property, receiver);
      }

      if (skippedProxyProperties.has(property)) return undefined;

      const cached = Reflect.get(target, property, receiver);
      if (typeof cached === 'function') return cached;

      const method = async (...args: unknown[]) => {
        requireKugouApiCapability(descriptor);
        const api = await loadApiFunction(namespace, property);
        // 标记为插件来源：插件经 ctx.kugou 发起的请求绕过服务拦截链（防递归）。
        // 业务 api 函数均在同步段发起 request.get/post，因此同步包裹即可正确标记。
        return runWithRequestOrigin({ type: 'plugin', pluginId: descriptor.id }, () =>
          (api as RuntimeApiFunction)(...args),
        );
      };

      Reflect.set(target, property, method, receiver);
      return method;
    },
  });

export const createKugouApi = (descriptor: EchoPluginDescriptor): PluginKugouApi =>
  new Proxy({} as PluginKugouApi, {
    get(target, property, receiver) {
      if (typeof property !== 'string') {
        return Reflect.get(target, property, receiver);
      }

      if (skippedProxyProperties.has(property)) return undefined;

      const cached = Reflect.get(target, property, receiver);
      if (cached) return cached;

      const namespace = createApiNamespace(descriptor, property);
      Reflect.set(target, property, namespace, receiver);
      return namespace;
    },
  });
