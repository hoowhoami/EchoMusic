<template>
  <Teleport to="body">
    <Transition name="fade">
      <div v-if="visible" class="global-loading">
        <NSpace vertical align="center" :size="16">
          <NSpin size="large" />
          <NText depth="3">{{ message }}</NText>
        </NSpace>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { NSpace, NSpin, NText } from 'naive-ui';
import { ref } from 'vue';

const visible = ref(false);
const message = ref('加载中...');

const show = (msg = '加载中...') => {
  message.value = msg;
  visible.value = true;
};

const hide = () => {
  visible.value = false;
};

defineExpose({
  show,
  hide,
});
</script>

<style scoped>
.global-loading {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(255, 255, 255, 0.8);
  backdrop-filter: blur(4px);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 9999;
}

.dark .global-loading {
  background: rgba(0, 0, 0, 0.8);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>