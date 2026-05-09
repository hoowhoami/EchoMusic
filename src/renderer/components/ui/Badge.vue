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
      'badge absolute -top-1.5 -right-5 inline-flex min-w-[16px] h-4 items-center justify-center px-1 rounded-full text-[9px] font-bold bg-black text-white dark:bg-white dark:text-black shadow-sm select-none pointer-events-none tabular-nums',
      props.class,
    ]"
  >
    {{ count }}
  </span>
</template>

<style scoped>
.badge {
  /* 固定深浅背景保证任何主题色下都清晰 */
}
</style>
