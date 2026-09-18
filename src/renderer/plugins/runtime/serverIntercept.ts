import type { EchoPluginDescriptor } from '../../../shared/plugins';
import type {
  PluginServerInterceptOptions,
  PluginServerInterceptor,
  PluginServerMatcher,
  PluginServerNext,
  PluginServerRequest,
  PluginServerResponse,
} from '../../../shared/plugins';
import {
  isValidServerResponse,
  registerServerInterceptor,
  runWithRequestOrigin,
} from '../../utils/serverInterceptors';

interface ServerInterceptApiDeps {
  addDisposable: (dispose: () => void) => () => void;
  reportPluginRuntimeError: (pluginId: string, error: unknown, source?: string) => void;
}

export interface PluginServerInterceptApi {
  intercept: (
    interceptor: PluginServerInterceptor,
    options?: PluginServerInterceptOptions,
  ) => () => void;
}

/**
 * fail-open 包装：插件拦截器任何异常都不能导致主程序断网。
 * next 由执行器保证幂等，因此 catch 中可无脑 return next()：
 * - 调用 next 之前抛错 → 正常放行出网；
 * - await next() 之后加工响应时抛错 → 返回同一个下游结果，不会重复出网。
 *
 * 透传识别：插件未捕获直接 return next() 时，下游的真实网络错误会从 handler 抛出。
 * 通过记录下游 rejection 的错误身份并在 catch 中比对，这类失败不再被误报为插件错误。
 */
const wrapSafe =
  (
    pluginId: string,
    handler: PluginServerInterceptor,
    reportError: ServerInterceptApiDeps['reportPluginRuntimeError'],
  ): PluginServerInterceptor =>
  async (request, next) => {
    let downstream: Promise<PluginServerResponse> | undefined;
    let downstreamError: unknown;
    // 录制 rejection 的原始错误；注册先于 handler 的 await，因此 wrapSafe 的 catch
    // 执行时 downstreamError 必已就位。
    const trackNext: PluginServerNext = (...args) => {
      downstream ??= next(...args).catch((error) => {
        downstreamError = error;
        throw error;
      });
      return downstream;
    };
    try {
      const result = await runWithRequestOrigin({ type: 'plugin', pluginId }, () =>
        handler(request, trackNext),
      );
      return isValidServerResponse(result) ? result : trackNext();
    } catch (error) {
      if (downstream && downstreamError !== undefined && error === downstreamError) {
        return downstream; // 插件透传的下游失败：不上报，原样继续向上传播
      }
      reportError(pluginId, error, '服务请求拦截器');
      return trackNext();
    }
  };

/** 谓词型 match 在执行器内直接调用，插件抛错时按"不匹配"处理，避免污染整个链 */
const wrapMatcher = (
  pluginId: string,
  matcher: PluginServerMatcher | undefined,
  reportError: ServerInterceptApiDeps['reportPluginRuntimeError'],
): PluginServerMatcher | undefined => {
  if (typeof matcher !== 'function') return matcher;
  return (request: PluginServerRequest) => {
    try {
      return matcher(request) === true;
    } catch (error) {
      reportError(pluginId, error, '服务请求拦截器匹配条件');
      return false;
    }
  };
};

export const createServerInterceptApi = (
  descriptor: EchoPluginDescriptor,
  deps: ServerInterceptApiDeps,
): PluginServerInterceptApi => ({
  intercept: (interceptor, options = {}) => {
    if (descriptor.manifest.capabilities?.serverIntercept !== true) {
      throw new Error('插件未声明服务请求拦截能力（capabilities.serverIntercept）');
    }
    const safeHandler = wrapSafe(descriptor.id, interceptor, deps.reportPluginRuntimeError);
    const safeOptions: PluginServerInterceptOptions = {
      ...options,
      match: wrapMatcher(descriptor.id, options.match, deps.reportPluginRuntimeError),
    };
    const dispose = registerServerInterceptor(descriptor.id, safeHandler, safeOptions);
    return deps.addDisposable(dispose);
  },
});
