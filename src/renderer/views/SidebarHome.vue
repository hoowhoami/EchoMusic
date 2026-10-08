<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import Button from '@/components/ui/Button.vue';
import { useSettingStore } from '@/stores/setting';
import { useToastStore } from '@/stores/toast';
import { resolveSidebarHomeEntry } from '@/layouts/sidebarShortcutEntries';
defineOptions({ name: 'sidebar-home-page' });

// 页面卡片由路由直接打开；操作卡片在首页使用与侧边栏点击相同的行为。
const settings = useSettingStore();
const router = useRouter();
const toast = useToastStore();
const entry = computed(() => resolveSidebarHomeEntry(settings.sidebarLayout));
const busy = ref(false);
const openHome = async () => {
  const current = entry.value;
  if (busy.value || current.disabled) return;
  busy.value = true;
  try {
    if (current.onClick) await current.onClick();
    else if (current.path) await router.replace(current.path);
  } catch (error) {
    toast.warning(error instanceof Error ? error.message : '无法打开首页');
  } finally {
    busy.value = false;
  }
};
onMounted(() => void openHome());
</script>

<template>
  <main class="flex flex-col items-start gap-4 px-6 py-8">
    <span class="text-sm text-text-secondary">首页</span>
    <h1 class="text-2xl font-bold text-text-main">{{ entry.title }}</h1>
    <Button variant="secondary" :disabled="busy || entry.disabled" @click="openHome">
      {{ entry.disabled ? '当前不可用' : busy ? '正在打开…' : '打开' }}
    </Button>
  </main>
</template>
