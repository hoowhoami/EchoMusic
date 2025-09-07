<template>
  <div class="scrollable-loading">
    <NInfiniteScroll
      @load="handleLoad"
      :style="{ height: `${props.height}px` }"
    >
      <slot
        :list="list"
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
import { NInfiniteScroll, NSpin } from 'naive-ui';
import { onMounted, ref } from 'vue';

defineOptions({
  name: 'PageableScrollLoading',
});

const loading = ref(false);
const noMore = ref(false);
const page = ref(1);
const list = ref<object[]>([]);

const props = withDefaults(
  defineProps<{
    height?: number;
    distance?: number;
    pageSize?: number;
    // eslint-disable-next-line no-unused-vars
    loader: (page: number, pageSize: number) => Promise<object[]>;
  }>(),
  {
    height: 300,
    distance: 0,
    pageSize: 30,
    loader: () => Promise.resolve([]),
  },
);

const handleLoad = () => {
  if (loading.value || noMore.value) {
    return;
  }
  const loader = props.loader;
  if (!loader || !(loader instanceof Function)) {
    return;
  }
  try {
    loading.value = true;
    loader(page.value, props.pageSize)
      .then(data => {
        if (data && data.length > 0) {
          list.value.push(...data);
        }
        if (!data || data.length < props.pageSize) {
          noMore.value = true;
        } else {
          page.value = page.value + 1;
        }
      })
      .catch(error => {
        console.error('Failed to load data', error);
      });
  } catch (error) {
    console.error('Failed to handle load', error);
  } finally {
    loading.value = false;
  }
};

onMounted(() => {
  handleLoad();
});
</script>

<style lang="scss" scoped>
.scrollable-loading {
  .loading {
    height: 30px;
  }
  .no-more {
    height: 30px;
    font-size: 12px;
  }
}
</style>
