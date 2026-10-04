<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { iconX, iconMinus } from '@/icons';
import arrowsDiagonal from '@iconify/icons-tabler/arrows-diagonal';
import Tooltip from '@/components/ui/Tooltip.vue';

const isMac = window.electron.platform === 'darwin';
const control = (action: 'close' | 'minimize' | 'maximize') =>
  window.electron.windowControl(action);
</script>

<template>
  <div v-if="!isMac" class="traffic-lights no-drag" role="group" aria-label="窗口控制">
    <Tooltip content="关闭" side="bottom">
      <template #trigger>
        <button class="traffic-light close" aria-label="关闭窗口" @click="control('close')">
          <span><Icon :icon="iconX" :width="9" /></span>
        </button>
      </template>
    </Tooltip>
    <Tooltip content="最小化" side="bottom">
      <template #trigger>
        <button class="traffic-light minimize" aria-label="最小化窗口" @click="control('minimize')">
          <span><Icon :icon="iconMinus" :width="9" /></span>
        </button>
      </template>
    </Tooltip>
    <Tooltip content="最大化 / 还原" side="bottom">
      <template #trigger>
        <button
          class="traffic-light maximize"
          aria-label="最大化或还原窗口"
          @click="control('maximize')"
        >
          <span><Icon :icon="arrowsDiagonal" :width="9" /></span>
        </button>
      </template>
    </Tooltip>
  </div>
</template>

<style scoped>
.traffic-lights {
  position: absolute;
  top: 10px;
  left: 10px;
  display: flex;
  z-index: 210;
  -webkit-app-region: no-drag;
}
.traffic-light {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  padding: 0;
  background: transparent;
  border: 0;
  cursor: default;
  -webkit-app-region: no-drag;
}
.traffic-light span {
  display: grid;
  place-items: center;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 1px solid rgb(0 0 0 / 12%);
  color: rgb(0 0 0 / 60%);
}
.traffic-light.close span {
  background: #ff5f57;
}
.traffic-light.minimize span {
  background: #febc2e;
}
.traffic-light.maximize span {
  background: #28c840;
}
.traffic-light svg {
  opacity: 0;
}
.traffic-lights:hover svg,
.traffic-light:focus-visible svg {
  opacity: 1;
}
.traffic-light:focus-visible {
  outline: 2px solid var(--color-focus-ring);
  border-radius: 5px;
}
.traffic-light:active span {
  filter: brightness(0.85);
}
</style>
