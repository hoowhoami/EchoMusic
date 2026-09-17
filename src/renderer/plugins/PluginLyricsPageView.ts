import { defineComponent, h, onErrorCaptured, onScopeDispose, provide } from 'vue';
import type { PropType } from 'vue';
import {
  failLyricsPage,
  lyricsPageContextKey,
  lyricsPageSkinKey,
  resolveLyricsPage,
  scopeLyricsPageContext,
} from './lyricsPage';
import type { LyricsPageContribution } from './lyricsPage';
import type { LyricsPageContext } from '../views/lyric/composables/useLyricsPageContext';
import { useLyricSkin } from '../views/lyric/composables/useLyricSkin';

/** Keep plugin errors inside the overlay; the host then renders its native content. */
export default defineComponent({
  name: 'PluginLyricsPageView',
  props: {
    contribution: { type: Object as PropType<LyricsPageContribution>, required: true },
    page: { type: Object as PropType<LyricsPageContext>, required: true },
  },
  setup(props) {
    let mounted = true;
    const page = scopeLyricsPageContext(
      props.page,
      () => mounted && resolveLyricsPage(props.contribution.key) === props.contribution,
    );
    provide(lyricsPageContextKey, page);
    // 皮肤配置：插件页面组件可通过 ctx.ui.lyricsPage.useSkin() 读取当前皮肤配置。
    const skin = useLyricSkin(
      props.contribution.key,
      props.contribution.settings?.defaults ?? {},
      props.contribution.settings?.validate,
    );
    provide(lyricsPageSkinKey, skin);
    onScopeDispose(() => {
      mounted = false;
    });
    onErrorCaptured((error) => {
      failLyricsPage(props.contribution, error);
      return false;
    });
    return () => h(props.contribution.component, { page });
  },
});
