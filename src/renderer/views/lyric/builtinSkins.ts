import { defineAsyncComponent } from 'vue';
import type { BuiltinLyricSkin } from '@/plugins/lyricsPage';
import CoverMode from './CoverMode.vue';
import PortraitMode from './PortraitMode.vue';
import LyricMode from './LyricMode.vue';
import coverSettings from './skins/CoverSkinSettings.vue';
import lyricSettings from './skins/LyricSkinSettings.vue';
import portraitSettings from './skins/PortraitSkinSettings.vue';
import {
  HOST_SKIN_KEYS,
  LYRIC_SKIN_AMLL_DEFAULTS,
  LYRIC_SKIN_COVER_DEFAULTS,
  LYRIC_SKIN_LYRIC_DEFAULTS,
  LYRIC_SKIN_PORTRAIT_DEFAULTS,
} from './skins/config';

/**
 * Apple Music（AMLL）皮肤采用异步组件：只有当该皮肤被使用时才加载
 * 其依赖的 AMLL / Pixi 代码，避免拖慢启动与常驻内存。
 */
const amllMode = defineAsyncComponent(() => import('./AmllMode.vue'));
const amllSettings = defineAsyncComponent(() => import('./skins/AmllSkinSettings.vue'));

const validateAmllSettings = (values: Record<string, unknown>) => {
  const align = Number(values.alignPosition);
  const fade = Number(values.wordFadeWidth);
  let errors: string[] | undefined;
  if (!Number.isFinite(align) || align < 0 || align > 1) {
    errors = ['歌词位置需在 0~1 之间'];
  } else if (!Number.isFinite(fade) || fade <= 0) {
    errors = ['渐变宽度需大于 0'];
  }
  return { errors };
};

/** 内置皮肤，与自定义皮肤共用同一套选择与设置机制。 */
export const builtinLyricSkins: BuiltinLyricSkin[] = [
  {
    pluginId: 'host',
    id: 'cover',
    key: HOST_SKIN_KEYS.cover,
    title: '封面',
    component: CoverMode,
    titlebar: 'host',
    tools: 'host',
    category: 'player',
    settings: {
      defaults: LYRIC_SKIN_COVER_DEFAULTS,
      component: coverSettings,
    },
  },
  {
    pluginId: 'host',
    id: 'portrait',
    key: HOST_SKIN_KEYS.portrait,
    title: '写真',
    component: PortraitMode,
    titlebar: 'host',
    tools: 'host',
    category: 'player',
    settings: {
      defaults: LYRIC_SKIN_PORTRAIT_DEFAULTS,
      component: portraitSettings,
    },
  },
  {
    pluginId: 'host',
    id: 'lyric',
    key: HOST_SKIN_KEYS.lyric,
    title: '简洁歌词',
    component: LyricMode,
    titlebar: 'host',
    tools: 'host',
    category: 'effect',
    settings: {
      defaults: LYRIC_SKIN_LYRIC_DEFAULTS,
      component: lyricSettings,
    },
  },
  {
    pluginId: 'host',
    id: 'amll',
    key: HOST_SKIN_KEYS.amll,
    title: 'Apple Music',
    component: amllMode,
    titlebar: 'host',
    tools: 'host',
    category: 'effect',
    settings: {
      defaults: LYRIC_SKIN_AMLL_DEFAULTS,
      validate: validateAmllSettings,
      component: amllSettings,
    },
  },
];
