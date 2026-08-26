<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Icon } from '@iconify/vue';
import { iconArrowLeft, iconHeadphones, iconLoader2, iconRefreshCw } from '@/icons';
import Scrollbar from '@/components/ui/Scrollbar.vue';
import OnlineAudioEffectCard from './OnlineAudioEffectCard.vue';
import type { AudioEffectPlazaState, EffectPlazaCategory } from '@/composables/useAudioEffectPlaza';
import type { CommunityAudioEffectSort } from '@/api/audioEffect';

const props = defineProps<{ plaza: AudioEffectPlazaState }>();
const categories: { id: EffectPlazaCategory; label: string; description: string }[] = [
  { id: 'artist', label: '歌手音效', description: '为歌声量身调校，发现熟悉旋律的另一面' },
  { id: 'headphone', label: '耳机专属', description: '选择耳机品牌与型号，找到适合设备的调音' },
  { id: 'market', label: '音效市场', description: '发现创作者的调音作品，收藏不同的听感' },
];
const sorts: { value: CommunityAudioEffectSort; label: string }[] = [
  { value: 2, label: '推荐' },
  { value: 3, label: '最热' },
  { value: 4, label: '最新' },
];
const description = computed(
  () => categories.find((item) => item.id === props.plaza.category)?.description,
);
const loading = computed(() =>
  props.plaza.isBrandDirectory
    ? props.plaza.brands.loading || props.plaza.common.loading
    : props.plaza.currentPage.loading,
);
const scroll = ref<InstanceType<typeof Scrollbar> | null>(null);
watch(
  () => props.plaza.pageKey,
  () => scroll.value?.setScrollTop(0),
);
const refresh = () => {
  scroll.value?.setScrollTop(0);
  if (props.plaza.isBrandDirectory) {
    void props.plaza.loadBrands(true);
    void props.plaza.loadCommon();
  } else void props.plaza.loadEffects(true);
};
</script>

<template>
  <section class="effect-plaza" aria-label="音效广场">
    <header class="plaza-header">
      <div>
        <h2>音效广场</h2>
        <p>{{ description }}</p>
      </div>
      <button
        type="button"
        class="plaza-refresh"
        :disabled="loading"
        aria-label="刷新音效广场"
        title="刷新当前分类"
        @click="refresh"
      >
        <Icon :icon="iconRefreshCw" width="15" :class="{ 'plaza-spin': loading }" />
      </button>
    </header>
    <nav class="plaza-tabs" aria-label="音效分类">
      <button
        v-for="item in categories"
        :key="item.id"
        type="button"
        :aria-pressed="plaza.category === item.id"
        :class="{ 'is-active': plaza.category === item.id }"
        @click="plaza.selectCategory(item.id)"
      >
        {{ item.label }}
      </button>
    </nav>
    <div v-if="plaza.category === 'market'" class="plaza-tools">
      <div class="plaza-sorts" aria-label="音效市场排序">
        <button
          v-for="sort in sorts"
          :key="sort.value"
          type="button"
          :aria-pressed="plaza.marketSort === sort.value"
          :class="{ 'is-active': plaza.marketSort === sort.value }"
          @click="plaza.selectSort(sort.value)"
        >
          {{ sort.label }}
        </button>
      </div>
      <span v-if="plaza.currentPage.loaded">{{ plaza.currentPage.total }} 个音效</span>
    </div>
    <div v-else-if="plaza.category === 'headphone' && plaza.selectedBrand" class="plaza-tools">
      <button type="button" class="plaza-back" @click="plaza.selectBrand(null)">
        <Icon :icon="iconArrowLeft" width="13" />全部品牌
      </button>
      <strong
        >{{ plaza.selectedBrand.name
        }}<span v-if="plaza.currentPage.loaded"> · {{ plaza.currentPage.total }} 款</span></strong
      >
    </div>
    <p v-else-if="plaza.category === 'artist'" class="plaza-note">
      手动应用于播放，不会按歌曲歌手自动切换。
    </p>
    <Scrollbar ref="scroll" class="plaza-scroll">
      <div class="plaza-body" :aria-busy="loading">
        <template v-if="plaza.isBrandDirectory">
          <div class="plaza-section-heading">
            <strong>通用耳机</strong><span>找不到型号？试试通用调音</span>
          </div>
          <OnlineAudioEffectCard
            v-if="plaza.common.effect"
            :effect="plaza.common.effect"
            :plaza="plaza"
          />
          <div v-else-if="plaza.common.loading" class="plaza-inline-state">
            <Icon :icon="iconLoader2" width="14" class="plaza-spin" />正在加载通用音效…
          </div>
          <div v-if="plaza.common.error" class="plaza-inline-state" role="status">
            {{ plaza.common.error }}<button type="button" @click="plaza.loadCommon">重试</button>
          </div>
          <div v-else-if="plaza.common.loaded && !plaza.common.effect" class="plaza-inline-state">
            暂无通用耳机音效
          </div>
          <div class="plaza-section-heading">
            <strong>按品牌查找</strong
            ><span v-if="plaza.brands.loaded">{{ plaza.brands.total }} 个品牌</span>
          </div>
          <div v-if="plaza.brands.items.length" class="brand-grid">
            <button
              v-for="brand in plaza.brands.items"
              :key="brand.id"
              type="button"
              class="brand-card"
              @click="plaza.selectBrand(brand)"
            >
              <Icon :icon="iconHeadphones" width="19" />
              <span
                ><strong>{{ brand.name }}</strong
                ><small>{{ brand.modelCount }} 款耳机</small></span
              >
            </button>
          </div>
          <div v-if="plaza.brands.error" class="plaza-inline-state" role="status">
            {{ plaza.brands.error
            }}<button type="button" @click="plaza.loadBrands(plaza.brands.retryReset)">重试</button>
          </div>
          <div v-else-if="plaza.brands.loading && !plaza.brands.items.length" class="plaza-state">
            <Icon :icon="iconLoader2" width="18" class="plaza-spin" />正在加载耳机品牌…
          </div>
          <div v-else-if="plaza.brands.loaded && !plaza.brands.items.length" class="plaza-state">
            暂无耳机品牌
          </div>
          <button
            v-if="plaza.brands.hasMore && !plaza.brands.error"
            type="button"
            class="plaza-more"
            :disabled="plaza.brands.loading"
            @click="plaza.loadBrands()"
          >
            {{ plaza.brands.loading ? '加载中…' : '更多品牌' }}
          </button>
        </template>
        <template v-else>
          <OnlineAudioEffectCard
            v-for="effect in plaza.currentPage.items"
            :key="effect.id"
            :effect="effect"
            :plaza="plaza"
          />
          <div v-if="plaza.currentPage.error" class="plaza-state" role="status">
            <span>{{ plaza.currentPage.error }}</span
            ><button type="button" @click="plaza.loadEffects(plaza.currentPage.retryReset)">
              重试
            </button>
          </div>
          <div
            v-else-if="plaza.currentPage.loading && !plaza.currentPage.items.length"
            class="plaza-state"
          >
            <Icon :icon="iconLoader2" width="20" class="plaza-spin" />正在加载音效…
          </div>
          <div
            v-else-if="plaza.currentPage.loaded && !plaza.currentPage.items.length"
            class="plaza-state"
          >
            <Icon :icon="iconHeadphones" width="24" /><span
              >暂无{{
                plaza.category === 'artist'
                  ? '歌手音效'
                  : plaza.category === 'headphone'
                    ? '该品牌的耳机音效'
                    : '市场音效'
              }}</span
            ><button type="button" @click="refresh">重新加载</button>
          </div>
          <button
            v-if="plaza.currentPage.hasMore && !plaza.currentPage.error"
            type="button"
            class="plaza-more"
            :disabled="plaza.currentPage.loading"
            @click="plaza.loadEffects()"
          >
            {{ plaza.currentPage.loading ? '加载中…' : '加载更多' }}
          </button>
          <p
            v-else-if="
              plaza.currentPage.items.length &&
              !plaza.currentPage.loading &&
              !plaza.currentPage.error
            "
            class="plaza-end"
          >
            已展示全部音效
          </p>
        </template>
      </div>
    </Scrollbar>
    <footer class="plaza-footer">下载后可在「音效 · 我的音效」中使用</footer>
  </section>
</template>

<style scoped>
.effect-plaza {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  min-width: 0;
}
.plaza-header {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 14px 14px 10px;
}
.plaza-header h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
  color: var(--color-text-main);
}
.plaza-header p {
  margin: 5px 0 0;
  font-size: 10px;
  line-height: 1.4;
  color: var(--color-text-secondary);
}
.plaza-refresh {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 26px;
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
}
.plaza-refresh:hover {
  background: var(--control-muted-bg);
  color: var(--color-primary);
}
.plaza-refresh:disabled {
  opacity: 0.5;
  cursor: wait;
}
.plaza-tabs {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  flex-shrink: 0;
  gap: 3px;
  margin: 0 12px 9px;
  padding: 3px;
  border-radius: 8px;
  background: var(--control-muted-bg);
}
.plaza-tabs button {
  height: 28px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  font-size: 11px;
  font-weight: 650;
  color: var(--color-text-secondary);
  cursor: pointer;
}
.plaza-tabs button.is-active {
  color: var(--color-primary);
  background: var(--color-bg-elevated);
  box-shadow: inset 0 0 0 1px var(--control-border);
}
.plaza-tools {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  min-height: 25px;
  gap: 8px;
  padding: 0 12px 9px;
  font-size: 10px;
  color: var(--color-text-secondary);
}
.plaza-tools strong {
  color: var(--color-text-main);
  font-size: 11px;
}
.plaza-tools strong span {
  font-weight: 500;
  color: var(--color-text-secondary);
}
.plaza-sorts {
  display: flex;
  gap: 3px;
}
.plaza-sorts button {
  padding: 3px 9px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 10px;
  cursor: pointer;
}
.plaza-sorts button.is-active {
  background: color-mix(in srgb, var(--color-primary) 10%, transparent);
  color: var(--color-primary);
}
.plaza-back {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 0;
  border: 0;
  background: transparent;
  color: var(--color-primary);
  font-size: 10px;
  cursor: pointer;
}
.plaza-note {
  flex-shrink: 0;
  margin: 0 14px 9px;
  color: var(--color-text-secondary);
  font-size: 10px;
  line-height: 1.5;
}
.plaza-scroll {
  flex: 1;
  min-height: 0;
}
.plaza-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 0 12px 12px;
}
.plaza-section-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin: 5px 0 0;
}
.plaza-section-heading strong {
  font-size: 11px;
  color: var(--color-text-main);
}
.plaza-section-heading span {
  font-size: 9px;
  color: var(--color-text-secondary);
}
.brand-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 7px;
}
.brand-card {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 10px 8px;
  border: 1px solid var(--control-border);
  border-radius: 9px;
  background: var(--control-muted-bg);
  color: var(--color-text-secondary);
  cursor: pointer;
  text-align: left;
}
.brand-card svg {
  flex-shrink: 0;
  color: var(--color-primary);
}
.brand-card > span {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 3px;
}
.brand-card strong {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 11px;
  color: var(--color-text-main);
}
.brand-card small {
  font-size: 9px;
}
.brand-card:hover {
  border-color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 7%, transparent);
}
.plaza-state {
  display: flex;
  min-height: 130px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--color-text-secondary);
  font-size: 11px;
  text-align: center;
}
.plaza-inline-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 12px 4px;
  color: var(--color-text-secondary);
  font-size: 10px;
}
.plaza-state button,
.plaza-inline-state button {
  border: 0;
  padding: 4px;
  background: transparent;
  color: var(--color-primary);
  cursor: pointer;
}
.plaza-more {
  min-height: 30px;
  border: 0;
  border-radius: 7px;
  background: var(--control-muted-bg);
  color: var(--color-primary);
  font-size: 11px;
  cursor: pointer;
}
.plaza-more:disabled {
  opacity: 0.6;
  cursor: wait;
}
.plaza-end {
  margin: 4px 0;
  text-align: center;
  font-size: 9px;
  color: var(--color-text-secondary);
}
.plaza-footer {
  flex-shrink: 0;
  padding: 9px 12px;
  border-top: 1px solid var(--control-border);
  color: var(--color-text-secondary);
  font-size: 9px;
  text-align: center;
}
.effect-plaza button:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}
.plaza-spin {
  animation: plaza-spin 0.8s linear infinite;
}
@keyframes plaza-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
