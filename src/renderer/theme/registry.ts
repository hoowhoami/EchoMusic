import {
  computed,
  inject,
  markRaw,
  shallowReactive,
  type Component,
  type DeepReadonly,
  type ComputedRef,
  type InjectionKey,
} from 'vue';
import {
  DEFAULT_THEME_KEY,
  CUSTOM_THEME_KEY,
  neutralTokens,
  paletteFromSeed,
  validColor,
  copyAppearance,
  type AppThemeAppearance,
} from './model';
export interface AppThemeContext<T extends Record<string, unknown> = Record<string, unknown>> {
  key: string;
  isDark: ComputedRef<boolean>;
  settings: ComputedRef<DeepReadonly<T>>;
  accentColor: ComputedRef<string>;
  appearance: ComputedRef<DeepReadonly<AppThemeAppearance>>;
  motionEnabled: ComputedRef<boolean>;
  /** @deprecated Always zero. Window frosting belongs to the native desktop material. */
  imageBlur: ComputedRef<number>;
  updateSettings: (patch: Partial<T>) => void;
  resetSettings: () => void;
}
export const APP_THEME_TYPES = ['default', 'solid', 'dynamic'] as const;
export type AppThemeType = (typeof APP_THEME_TYPES)[number];
export interface AppThemeRegistration<T extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  title: string;
  description?: string;
  preview?: string;
  type?: AppThemeType;
  defaultMode?: 'system' | 'light' | 'dark';
  variants: { light: AppThemeAppearance; dark: AppThemeAppearance };
  settings?: {
    defaults: T;
    validate?: (values: T) => boolean | { errors?: string[] };
    component?: Component;
  };
  resolve?: (context: { isDark: boolean; settings: T }) => Partial<AppThemeAppearance>;
  decorations?: { background?: Component; sidebar?: Component; player?: Component };
}
export interface AppThemeEntry extends AppThemeRegistration {
  key: string;
  pluginId: string;
  revision: number;
  reportError: (error: unknown) => void;
}
const entries = shallowReactive<AppThemeEntry[]>([]);
const failed = shallowReactive(new Set<number>());
let revision = 0;
const variant = (dark: boolean): AppThemeAppearance => ({
  tokens: neutralTokens(dark),
  accent: '#0071e3',
});
export const builtinAppThemes: AppThemeEntry[] = [
  {
    id: 'echo',
    key: DEFAULT_THEME_KEY,
    title: 'Echo',
    type: 'default',
    description: '简约清爽，让音乐成为主角。',
    defaultMode: 'system',
  },
  {
    id: 'solid',
    key: 'host:solid',
    title: '纯色',
    type: 'solid',
    description: '选择颜色，生成完整界面配色',
    defaultMode: 'system',
  },
  {
    id: 'custom',
    key: CUSTOM_THEME_KEY,
    title: '自定义',
    description: '用本地图片创建独立皮肤',
    defaultMode: 'system',
  },
].map((item) => ({
  ...item,
  pluginId: 'host',
  revision: 0,
  variants:
    item.id === 'solid'
      ? {
          light: {
            ...variant(false),
            tokens: paletteFromSeed('#6b9bd1', false),
            accent: '#6b9bd1',
          },
          dark: { ...variant(true), tokens: paletteFromSeed('#6b9bd1', true), accent: '#6b9bd1' },
        }
      : { light: variant(false), dark: variant(true) },
  reportError: () => {},
})) as AppThemeEntry[];
export const appThemes = computed(() => [...builtinAppThemes, ...entries]);
// Custom backgrounds are selectable appearance state, not catalog theme packages.
export const catalogAppThemes = computed(() =>
  appThemes.value.filter((entry) => entry.key !== CUSTOM_THEME_KEY),
);
export const appThemeType = (entry: AppThemeEntry): AppThemeType => entry.type ?? 'default';
export const resolveAppTheme = (key: string) =>
  appThemes.value.find((entry) => entry.key === key && !failed.has(entry.revision));
export function failAppTheme(entry: AppThemeEntry, error: unknown) {
  if (entry.pluginId === 'host' || failed.has(entry.revision)) return;
  failed.add(entry.revision);
  entry.reportError(error);
}
export function retryAppTheme(key: string) {
  const entry = entries.find((e) => e.key === key);
  if (entry) failed.delete(entry.revision);
}
export const appThemeContextKey: InjectionKey<AppThemeContext> = Symbol('app-theme');
export function useAppTheme<T extends Record<string, unknown>>() {
  const context = inject(appThemeContextKey);
  if (!context) throw new Error('useTheme 必须在主题设置或装饰组件中调用');
  return context as AppThemeContext<T>;
}
let openHandler: (() => void) | null = null;
export const setOpenThemesHandler = (handler: (() => void) | null) => {
  openHandler = handler;
};
export const openAppThemes = () => openHandler?.();
export function createAppThemeApi(
  pluginId: string,
  addDisposable: (dispose: () => void) => unknown,
  reportError: (source: string, error: unknown) => void,
  allowed: boolean,
) {
  return {
    register<T extends Record<string, unknown>>(input: AppThemeRegistration<T>) {
      if (!allowed) throw new Error('插件未声明主题能力（capabilities.theme）');
      const id = String(input.id ?? '').trim();
      if (
        !id ||
        !input.title?.trim() ||
        !input.variants?.light?.tokens ||
        !input.variants?.dark?.tokens
      )
        throw new Error('主题需要 id、title 与 light/dark tokens');
      if (
        input.settings &&
        (!input.settings.defaults ||
          typeof input.settings.defaults !== 'object' ||
          Array.isArray(input.settings.defaults))
      )
        throw new Error('主题 settings.defaults 必须是普通对象');
      validateThemeAppearance(input.variants.light);
      validateThemeAppearance(input.variants.dark);
      if (input.type !== undefined && !APP_THEME_TYPES.includes(input.type))
        throw new Error('主题类型无效');
      if (input.defaultMode && !['system', 'light', 'dark'].includes(input.defaultMode))
        throw new Error('主题显示模式无效');
      if (input.resolve !== undefined && typeof input.resolve !== 'function')
        throw new Error('主题 resolve 必须是函数');
      if (input.settings) {
        assertJsonSettings(input.settings.defaults);
        const result = input.settings.validate?.(copyAppearance(input.settings.defaults));
        if (result === false || (typeof result === 'object' && result.errors?.length))
          throw new Error('主题默认配置无效');
      }
      const key = JSON.stringify([pluginId, id]);
      const entry: AppThemeEntry = {
        ...(input as AppThemeRegistration),
        variants: copyAppearance(input.variants),
        id,
        title: input.title.trim(),
        key,
        pluginId,
        revision: ++revision,
        reportError: (error) => reportError(`主题: ${id}`, error),
      };
      if (input.settings)
        entry.settings = {
          ...input.settings,
          defaults: copyAppearance(input.settings.defaults),
        } as AppThemeRegistration['settings'];
      if (input.settings?.component)
        entry.settings = {
          ...entry.settings!,
          component: markRaw(input.settings.component),
        } as AppThemeRegistration['settings'];
      if (input.decorations)
        entry.decorations = Object.fromEntries(
          Object.entries(input.decorations).map(([slot, component]) => [
            slot,
            component ? markRaw(component) : component,
          ]),
        );
      const old = entries.findIndex((e) => e.key === key);
      if (old >= 0) {
        failed.delete(entries[old].revision);
        entries.splice(old, 1);
      }
      entries.push(entry);
      const dispose = () => {
        const index = entries.indexOf(entry);
        if (index >= 0) entries.splice(index, 1);
        failed.delete(entry.revision);
      };
      addDisposable(dispose);
      return dispose;
    },
    useTheme: useAppTheme,
    openThemes: openAppThemes,
  };
}

export function validateThemeAppearance(value: Partial<AppThemeAppearance>) {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof (value as unknown as { then?: unknown }).then === 'function'
  )
    throw new Error('主题必须同步返回外观对象');
  for (const key of Object.keys(value.tokens ?? {}))
    if (!Object.hasOwn(neutralTokens(false), key)) throw new Error('未知主题颜色 token');
  for (const color of Object.values(value.tokens ?? {}))
    if (!validColor(color)) throw new Error('主题颜色必须为六位十六进制颜色');
  if (value.floating) {
    for (const [key, color] of Object.entries(value.floating)) {
      if (
        !['background', 'card', 'text', 'secondary', 'border'].includes(key) ||
        !validColor(color)
      )
        throw new Error('主题浮层颜色无效');
    }
  }
  if (value.accent !== undefined && !validColor(value.accent)) throw new Error('主题强调色无效');
  if (value.background?.color !== undefined && !validColor(value.background.color))
    throw new Error('主题背景颜色无效');
  if (
    value.background?.gradient &&
    !/^(linear|radial|conic)-gradient\(/.test(value.background.gradient)
  )
    throw new Error('主题背景渐变无效');
}
export function assertJsonSettings(value: unknown) {
  const visit = (node: unknown): void => {
    if (
      node === null ||
      typeof node === 'string' ||
      typeof node === 'boolean' ||
      (typeof node === 'number' && Number.isFinite(node))
    )
      return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node && typeof node === 'object' && Object.getPrototypeOf(node) === Object.prototype) {
      Object.values(node).forEach(visit);
      return;
    }
    throw new Error('主题配置只能包含 JSON 数据');
  };
  visit(value);
}
