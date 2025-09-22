<template>
  <div class="rank">
    <div class="grid grid-cols-[repeat(auto-fit,130px)] justify-center gap-4 p-2">
      <NTag
        v-for="rank in ranks"
        :key="rank.rankid"
        checkable
        v-model:checked="rank.checked"
      >
        {{ rank.rankname }}
      </NTag>
    </div>
    <div class="mt-2">
      <div class="grid grid-cols-[repeat(auto-fit,300px)] justify-center gap-4 p-2">
        <NCard
          v-for="rank in checkedRanks"
          :key="rank.rankid"
          size="small"
          hoverable
        >
          <template #header>
            <div>
              {{ rank.rankname }}
            </div>
          </template>
          <template #header-extra>
            <div>
              <NButton
                :focusable="false"
                text
                :loading="loading"
                @click="handleRefresh"
              >
                <template #icon>
                  <NIcon>
                    <RefreshRound />
                  </NIcon>
                </template>
              </NButton>
            </div>
          </template>
        </NCard>
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import type { Rank } from '@/types';
import { getRankList } from '@/api';
import { NButton, NCard, NIcon, NTag } from 'naive-ui';
import { computed, onMounted, ref } from 'vue';
import { RefreshRound } from '@vicons/material';

defineOptions({
  name: 'Rank',
});

interface CheckableRank extends Rank {
  checked: boolean;
}

const loading = ref(false);
const ranks = ref<CheckableRank[]>([]);
const checkedRanks = computed(() => ranks.value.filter(rank => rank.checked));

const getRank = async () => {
  try {
    loading.value = true;
    ranks.value = [];
    const res = await getRankList();
    console.log(res);
    ranks.value = res?.info || [];
  } catch (error) {
    console.log(error);
  } finally {
    loading.value = false;
  }
};

const handleRefresh = async () => {};

onMounted(async () => {
  await getRank();
});
</script>

<style lang="scss" scoped></style>
