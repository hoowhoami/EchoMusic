<template>
  <div class="mv-list flex flex-col space-y-2">
    <div
      class="item"
      v-for="item in props.list"
      :key="item.video_id"
    >
      <MVCard :mv="item" />
    </div>
  </div>
</template>

<script lang="ts" setup>
import type { MV } from '@/types';
import MVCard from '../Card/MVCard.vue';

defineOptions({
  name: 'MVList',
});

const props = defineProps<{
  list: MV[];
}>();
</script>
<style lang="scss" scoped></style>
