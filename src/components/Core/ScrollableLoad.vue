<template>
  <div class="scrollable-load">
    <NInfiniteScroll
      @load="handleThrottleLoad"
      :style="{ height: `${props.height}px` }"
    >
      <slot
        :list="loadedList"
        :loading="loading"
        :no-more="noMore"
      />
      <slot name="loading">
        <div
          v-if="loading"
          class="flex items-center justify-center loading"
        >
          <NSpin :size="20" />
        </div>
      </slot>
      <slot name="no-more">
        <div
          v-if="noMore"
          class="flex items-center justify-center no-more"
        >
          <NText depth="3"> 没有更多了 </NText>
        </div>
      </slot>
    </NInfiniteScroll>
  </div>
</template>

<script lang="ts" setup>
import { throttle } from 'lodash-es';
import { NInfiniteScroll, NSpin } from 'naive-ui';
import { nextTick, onMounted, ref } from 'vue';

defineOptions({
  name: 'ScrollableLoading',
});

const loading = ref(false);
const noMore = ref(false);
const page = ref(0);
const loadedList = ref<any[]>([]);

const props = withDefaults(
  defineProps<{
    height?: number;
    distance?: number;
    pageSize?: number;
    noMoreOnError?: boolean;
    // eslint-disable-next-line no-unused-vars
    loader: (page: number, pageSize: number) => Promise<{ list: any[]; total: number }>;
  }>(),
  {
    height: 300,
    distance: 0,
    pageSize: 30,
    noMoreOnError: false,
    loader: () => Promise.resolve({ list: [], total: 0 }),
  },
);

const handleThrottleLoad = throttle(async () => {
  await handleLoad();
}, 500);

const handleLoad = async () => {
  if (loading.value || noMore.value) {
    return;
  }
  const loader = props.loader;
  if (!loader || !(loader instanceof Function)) {
    return;
  }
  nextTick(async () => {
    try {
      page.value = page.value + 1;
      loading.value = true;
      const { list, total } = await loader(page.value, props.pageSize);
      if (list && list.length > 0) {
        loadedList.value.push(...list);
      }
      if (total !== undefined && total === 0) {
        noMore.value = true;
        return;
      } else {
        const maxPage = Math.ceil(total / props.pageSize);
        if (page.value >= maxPage) {
          noMore.value = true;
          return;
        }
      }
      if (!list || list.length < props.pageSize) {
        noMore.value = true;
      }
    } catch (error) {
      if (props.noMoreOnError) {
        noMore.value = true;
      }
      console.error('Failed to handle load', error);
    } finally {
      loading.value = false;
    }
  });
};

onMounted(() => {
  handleLoad();
});
</script>

<style lang="scss" scoped>
.scrollable-load {
  .loading {
    height: 30px;
  }
  .no-more {
    height: 30px;
    font-size: 12px;
  }
}
</style>
