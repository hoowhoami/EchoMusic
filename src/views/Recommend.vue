<template>
  <div class="recommend">recommend</div>
</template>

<script lang="ts" setup>
import { getEverydayRecommend } from '@/api';
import { onMounted } from 'vue';

defineOptions({
  name: 'Recommend',
});

const getDailyRecommend = async () => {
  const res = await getEverydayRecommend();
  console.log(res);
};

onMounted(() => {
  getDailyRecommend();
});
</script>

<style lang="scss" scoped></style>
