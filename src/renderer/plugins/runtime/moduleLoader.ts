import type { EchoPluginDescriptor } from '../../../shared/plugins';
import type { EchoPluginContext } from './context';

export type PluginModule =
  | {
      activate?: (ctx: EchoPluginContext) => unknown;
      deactivate?: (ctx: EchoPluginContext) => unknown;
      default?: PluginModuleDefault;
    }
  | PluginModuleDefault;

export type PluginModuleDefault =
  | ((ctx: EchoPluginContext) => unknown)
  | {
      activate?: (ctx: EchoPluginContext) => unknown;
      deactivate?: (ctx: EchoPluginContext) => unknown;
    };

export const resolvePluginActivator = (module: PluginModule) => {
  if (typeof module === 'function') return module;
  if (module && typeof module === 'object') {
    const defaultExport = Reflect.get(module, 'default') as PluginModuleDefault | undefined;
    if (typeof defaultExport === 'function') return defaultExport;
    if (
      defaultExport &&
      typeof defaultExport === 'object' &&
      typeof defaultExport.activate === 'function'
    ) {
      return defaultExport.activate.bind(defaultExport);
    }
    if (typeof Reflect.get(module, 'activate') === 'function') {
      return (Reflect.get(module, 'activate') as (ctx: EchoPluginContext) => unknown).bind(module);
    }
  }
  return null;
};

export const resolvePluginDeactivator = (module: PluginModule) => {
  if (module && typeof module === 'object') {
    const defaultExport = Reflect.get(module, 'default') as PluginModuleDefault | undefined;
    if (
      defaultExport &&
      typeof defaultExport === 'object' &&
      typeof defaultExport.deactivate === 'function'
    ) {
      return defaultExport.deactivate.bind(defaultExport);
    }
    if (typeof Reflect.get(module, 'deactivate') === 'function') {
      return (Reflect.get(module, 'deactivate') as (ctx: EchoPluginContext) => unknown).bind(
        module,
      );
    }
  }
  return null;
};

export const importPluginModule = async (descriptor: EchoPluginDescriptor, code: string) => {
  const blob = new Blob([`${code}\n//# sourceURL=echo-plugin:${descriptor.id}`], {
    type: 'text/javascript',
  });
  const url = URL.createObjectURL(blob);
  const module = (await import(/* @vite-ignore */ url)) as PluginModule;
  return { module, url };
};
