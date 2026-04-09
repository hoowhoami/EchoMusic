<script setup lang="ts">
interface Props {
  count?: number | string;
  class?: string;
}

const props = defineProps<Props>();
</script>

<template>
  <span
    v-if="count !== undefined"
    :class="[
      'badge absolute -top-1.5 -right-5 min-w-[16px] h-4 px-1 rounded-full text-[9px] leading-4 font-bold bg-primary text-white shadow-sm select-none pointer-events-none',
      props.class,
    ]"
  >
    {{ count }}
  </span>
</template>

<style scoped>
.badge {
  /* 可以添加额外的全局样式 */
}
</style>
