<template>
  <div class="error flex flex-col items-center justify-center">
    <div class="title">我们在EchoMusic中发现了一些问题</div>
    <div class="mt-4">
      <NAlert
        type="error"
        title="出了点问题"
      >
        <NText :depth="2">
          <div class="desc">通常这种情况可以通过回到首页来解决</div>
        </NText>
        <NText :depth="3">
          <div class="desc mt-1">最终您也可以尝试重启应用程序来解决</div>
        </NText>
      </NAlert>
    </div>
    <div class="mt-4">
      <NButton
        size="small"
        :focusable="false"
        @click="goHome"
      >
        回到首页
      </NButton>
    </div>
  </div>
</template>

<script setup lang="ts">
import { NAlert, NButton, NText } from 'naive-ui';
import { useRouter } from 'vue-router';

defineOptions({
  name: 'Error',
});

const router = useRouter();

const goHome = () => {
  router.push('/');
};
</script>

<style lang="scss" scoped>
.error {
  width: 100%;
  height: 100vh;

  .title {
    font-size: 20px;
    font-weight: 800;
    color: brown;
  }

  .desc {
    font-size: 12px;
  }
}
</style>
