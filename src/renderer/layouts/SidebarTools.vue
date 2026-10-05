<script setup lang="ts">
import { Icon } from '@iconify/vue';
import circleChevronLeft from '@iconify/icons-tabler/circle-chevron-left';
import circleChevronRight from '@iconify/icons-tabler/circle-chevron-right';
import { iconSettings, iconShirt } from '@/icons';
import { useRouter } from 'vue-router';
import Tooltip from '@/components/ui/Tooltip.vue';
const toggle = () => window.dispatchEvent(new Event('echo:toggle-sidebar'));
const props = defineProps<{ collapsed?: boolean }>();
const router = useRouter();
</script>
<template>
  <div class="sidebar-app-tools" :class="{ 'is-rail': props.collapsed }">
    <Tooltip :content="collapsed ? '展开侧栏' : '折叠侧栏'"
      ><template #trigger
        ><button type="button" :aria-label="collapsed ? '展开侧栏' : '折叠侧栏'" @click="toggle">
          <Icon
            :icon="collapsed ? circleChevronRight : circleChevronLeft"
            :width="21"
          /></button></template
    ></Tooltip>
    <template v-if="!collapsed">
      <slot />
      <Tooltip content="设置"
        ><template #trigger
          ><button type="button" aria-label="设置" @click="router.push('/main/settings')">
            <Icon :icon="iconSettings" :width="21" /></button></template
      ></Tooltip>
      <Tooltip content="主题中心"
        ><template #trigger
          ><button type="button" aria-label="主题中心" @click="router.push('/main/themes')">
            <Icon :icon="iconShirt" :width="21" /></button></template
      ></Tooltip>
    </template>
  </div>
</template>
<style scoped>
.sidebar-app-tools {
  display: flex;
  justify-content: space-evenly;
  align-items: center;
  gap: 8px;
  padding: 10px 16px;
  color: var(--icon-main);
}
.sidebar-app-tools button {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 9px;
  cursor: pointer;
}
.sidebar-app-tools button:hover {
  background: var(--control-hover-bg);
  color: var(--text-main);
}
.sidebar-app-tools.is-rail {
  flex-direction: column;
  padding: 8px;
}
</style>
