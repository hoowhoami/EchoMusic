<template>
  <div class="mv-list">
    <NScrollbar :content-style="{ height: props.height ? props.height + 'px' : 'auto' }">
      <div class="flex flex-col space-y-2 p-2">
        <div
          class="item"
          v-for="item in props.list"
          :key="item.video_id"
        >
          <MVCard
            :mv="item"
            :playing="playing && current?.video_id === item.video_id"
            @play="handlePlay"
          />
        </div>
      </div>
    </NScrollbar>
  </div>
</template>

<script lang="ts" setup>
import type { MV } from '@/types';
import MVCard from '../Card/MVCard.vue';
import { ref } from 'vue';
import { NScrollbar } from 'naive-ui';

defineOptions({
  name: 'MVList',
});

const emit = defineEmits<{
  play: [mv: MV];
}>();

const current = ref<MV>();

const props = defineProps<{
  list: MV[];
  playing?: boolean;
  height?: number;
}>();

const handlePlay = (mv: MV) => {
  current.value = mv;
  emit('play', mv);
};
</script>
<style lang="scss" scoped></style>
