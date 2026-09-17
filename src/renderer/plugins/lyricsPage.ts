import { computed, getCurrentInstance, inject, isRef, markRaw, shallowReactive } from 'vue';
import type { Component, InjectionKey } from 'vue';
import type { LyricsPageContext } from '../views/lyric/composables/useLyricsPageContext';
import type { LyricSkinHandle } from '../views/lyric/composables/useLyricSkin';

export const HOST_SKIN_PREFIX = 'host:';
export type HostSkinId = 'cover' | 'portrait' | 'lyric' | 'amll';

/** 内置皮肤的功能分类，用于换肤面板分组展示。 */
export type LyricSkinCategory = 'player' | 'effect';

/**
 * 皮肤设置描述。defaults 为默认配置，validate 负责校验 patch 后的整体配置，
 * component 是宿主设置抽屉渲染的设置组件。
 */
export interface LyricsSkinSettings<T extends Record<string, unknown> = Record<string, unknown>> {
  defaults: T;
  /** 设置组件，渲染在宿主设置抽屉内。 */
  component?: Component;
  validate?: (values: T) => boolean | { errors?: string[] };
}

export interface LyricsPageRegistration {
  id: string;
  title?: string;
  /** 换肤面板预览图；缺省时使用占位卡片。 */
  preview?: string;
  component: Component;
  /** The lyric overlay header, never the main window search/navigation bar. */
  titlebar?: 'host' | 'none';
  /** 右侧歌词工具按钮（来源/翻译/音译/复制/偏移），默认 'host'。设为 'none' 时插件自行提供。 */
  tools?: 'host' | 'none';
  settings?: LyricsSkinSettings;
}

export interface LyricsPageContribution extends Omit<LyricsPageRegistration, 'titlebar' | 'tools'> {
  pluginId: string;
  key: string;
  revision: number;
  title: string;
  titlebar: 'host' | 'none';
  tools: 'host' | 'none';
  reportError: (error: unknown) => void;
}

/** 内置皮肤（封面 / 写真 / 歌词 / Apple Music），与自定义皮肤共用同一套选择与设置机制。 */
export interface BuiltinLyricSkin {
  pluginId: 'host';
  id: HostSkinId;
  key: string;
  title: string;
  preview?: string;
  component: Component;
  titlebar: 'host';
  tools: 'host';
  category?: LyricSkinCategory;
  settings?: LyricsSkinSettings;
}

export type LyricSkin = LyricsPageContribution | BuiltinLyricSkin;

const entries = shallowReactive<LyricsPageContribution[]>([]);
const failed = shallowReactive(new Set<number>());
let revision = 0;
export const lyricsPageContextKey: InjectionKey<LyricsPageContext> = Symbol('lyrics-page');
export const lyricsPageSkinKey: InjectionKey<LyricSkinHandle> = Symbol('lyrics-page-skin');

/** 宿主注册的换肤面板打开回调，供插件通过 ctx.ui.lyricsPage.openSkins() 调用。 */
let skinsOpenHandler: (() => void) | null = null;
export function setSkinsOpenHandler(handler: (() => void) | null) {
  skinsOpenHandler = handler;
}

import { builtinLyricSkins } from '../views/lyric/builtinSkins';

export const lyricsPages = computed<LyricSkin[]>(() => [
  ...builtinLyricSkins,
  ...entries.slice().sort((a, b) => a.key.localeCompare(b.key)),
]);

export function resolveLyricsPage(key: string): LyricSkin | undefined {
  if (key?.startsWith(HOST_SKIN_PREFIX)) {
    return builtinLyricSkins.find((skin) => skin.key === key);
  }
  return entries.find((entry) => entry.key === key && !failed.has(entry.revision));
}

/** 兼容旧数据：插件 key 原样返回；'host' 按 lyricViewMode 解析到内置皮肤。 */
export function resolveLyricSkinKey(provider: string, viewMode: string | HostSkinId): string {
  if (provider?.startsWith(HOST_SKIN_PREFIX)) return provider;
  if (provider === 'host') {
    const mode =
      viewMode === 'portrait' || viewMode === 'lyric' || viewMode === 'amll' ? viewMode : 'cover';
    return `${HOST_SKIN_PREFIX}${mode}`;
  }
  return provider;
}

export function failLyricsPage(entry: LyricsPageContribution, error: unknown) {
  if (!entries.includes(entry) || failed.has(entry.revision)) return;
  failed.add(entry.revision);
  entry.reportError(error);
}

export function retryLyricsPage(key: string) {
  const entry = entries.find((item) => item.key === key);
  if (entry) failed.delete(entry.revision);
}

/** Revoke retained action callbacks when the owning page is replaced or unmounted. */
export function scopeLyricsPageContext(
  page: LyricsPageContext,
  isActive: () => boolean,
): LyricsPageContext {
  const bind = (value: unknown): unknown => {
    if (typeof value === 'function')
      return (...args: unknown[]) => {
        if (!isActive()) throw new Error('插件歌词页已失效');
        return value(...args);
      };
    if (value && typeof value === 'object' && !isRef(value)) {
      return Object.freeze(
        Object.fromEntries(Object.entries(value).map(([key, item]) => [key, bind(item)])),
      );
    }
    return value;
  };
  return bind(page) as LyricsPageContext;
}

export function removeLyricsPagesByPlugin(pluginId: string) {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].pluginId !== pluginId) continue;
    failed.delete(entries[i].revision);
    entries.splice(i, 1);
  }
}

export function createLyricsPageApi(
  pluginId: string,
  addDisposable: (dispose: () => void) => void,
  reportError: (source: string, error: unknown) => void,
) {
  return {
    register(input: LyricsPageRegistration) {
      const id = String(input.id ?? '').trim();
      if (!id || !input.component || !['object', 'function'].includes(typeof input.component)) {
        throw new Error('歌词页需要 id 和 Vue component');
      }
      const titlebar = input.titlebar ?? 'host';
      if (titlebar !== 'host' && titlebar !== 'none') {
        throw new Error('歌词页 titlebar 必须为 host 或 none');
      }
      const tools = input.tools ?? 'host';
      if (tools !== 'host' && tools !== 'none') {
        throw new Error('歌词页 tools 必须为 host 或 none');
      }
      if (input.settings !== undefined) {
        if (!input.settings || typeof input.settings !== 'object') {
          throw new Error('歌词页 settings 必须是对象');
        }
        if (!input.settings.defaults || typeof input.settings.defaults !== 'object') {
          throw new Error('歌词页 settings.defaults 必须是对象');
        }
        if (input.settings.validate && typeof input.settings.validate !== 'function') {
          throw new Error('歌词页 settings.validate 必须是函数');
        }
      }
      const key = JSON.stringify([pluginId, id]);
      const entry: LyricsPageContribution = {
        pluginId,
        id,
        key,
        revision: ++revision,
        title: input.title?.trim() || id,
        preview: input.preview,
        component: markRaw(input.component),
        titlebar,
        tools,
        settings: input.settings,
        reportError: (error) => reportError(`歌词页: ${id}`, error),
      };
      const previous = entries.findIndex((item) => item.key === key);
      if (previous >= 0) {
        failed.delete(entries[previous].revision);
        entries.splice(previous, 1);
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
    /** Call synchronously in the replacement component's setup(). */
    usePage(): LyricsPageContext {
      const page = getCurrentInstance() ? inject(lyricsPageContextKey, null) : null;
      if (!page) throw new Error('lyricsPage.usePage() 只能在歌词页组件 setup() 中调用');
      return page;
    },
    /**
     * 返回当前皮肤的配置句柄，可在页面组件与设置组件中调用。
     * 宿主按皮肤隔离配置，patch 会先经过皮肤的 validate 再持久化。
     */
    useSkin<T extends Record<string, unknown>>(): LyricSkinHandle<T> {
      if (!getCurrentInstance()) {
        throw new Error('lyricsPage.useSkin() 只能在 Vue 组件 setup() 中调用');
      }
      const handle = inject(lyricsPageSkinKey, null);
      if (!handle) {
        throw new Error('lyricsPage.useSkin() 缺少皮肤上下文（应为歌词页或皮肤设置面板渲染）');
      }
      return handle as LyricSkinHandle<T>;
    },
    /** 打开宿主换肤面板。完全自定义的插件可在自己的 UI 中调用此方法提供换肤入口。 */
    openSkins() {
      skinsOpenHandler?.();
    },
  };
}
