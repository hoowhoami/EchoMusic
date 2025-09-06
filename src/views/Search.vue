<template>
  <div>{{ keyword }}</div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';

defineOptions({
  name: 'SearchResult',
});

const route = useRoute();

const keyword = ref('');

watch(
  () => route.query.keyword,
  newValue => {
    keyword.value = newValue as string;
  },
);

onMounted(() => {
  keyword.value = route.query.keyword as string;
});
</script>

<style scoped></style>
