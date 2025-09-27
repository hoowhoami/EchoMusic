<template>
  <div class="main-content">
    <!-- 路由页面 -->
    <RouterView v-slot="{ Component }">
      <Transition
        name="router-transition"
        mode="out-in"
      >
        <component
          :is="Component"
          :key="$route.fullPath"
          class="router-view"
        />
      </Transition>
    </RouterView>
    <!-- 回到顶部 -->
    <NBackTop
      :right="20"
      :bottom="90"
    />
  </div>
</template>

<script setup lang="ts">
import { NBackTop } from 'naive-ui';
</script>

<style scoped>
.main-content {
  width: 100%;
}
</style>

<style>
/* 进入过渡开始状态 */
.router-transition-enter-from {
  opacity: 0;
  transform: translateX(30px);
}

/* 离开过渡结束状态 */
.router-transition-leave-to {
  opacity: 0;
  transform: translateX(-30px);
}

/* 进入和离开过渡的活跃状态 */
.router-transition-enter-active,
.router-transition-leave-active {
  transition: all 0.3s ease-out;
}

/* 进入过渡结束状态（可选） */
.router-transition-enter-to {
  opacity: 1;
  transform: translateX(0);
}

/* 进阶：根据路由方向动态改变动画 */
/* 后退时的动画（需要配合JS判断方向添加类） */
.router-transition-back .router-transition-enter-from {
  transform: translateX(-30px);
}

.router-transition-back .router-transition-leave-to {
  transform: translateX(30px);
}

/* 可选：淡入淡出效果变体 */
.router-transition-fade .router-transition-enter-from,
.router-transition-fade .router-transition-leave-to {
  opacity: 0;
  transform: none; /* 取消位移，只保留淡入淡出 */
}

/* 可选：缩放效果变体 */
.router-transition-scale .router-transition-enter-from {
  opacity: 0;
  transform: scale(0.95);
}

.router-transition-scale .router-transition-leave-to {
  opacity: 0;
  transform: scale(1.05);
}
</style>
