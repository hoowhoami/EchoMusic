<template>
  <div class="titlebar drag">
    <NFlex
      class="content"
      align="center"
      justify="space-between">
      <div class="no-drag nav">
        <NFlex align="center">
          <NButton
            ghost
            text
            :focusable="false"
            @click="router.go(-1)">
            <template #icon>
              <NIcon :size="25">
                <ArrowBackCircleOutline />
              </NIcon>
            </template>
          </NButton>
          <NButton
            ghost
            text
            :focusable="false"
            @click="router.go(1)">
            <template #icon>
              <NIcon :size="25">
                <ArrowForwardCircleOutline />
              </NIcon>
            </template>
          </NButton>
          <NButton
            ghost
            text
            :focusable="false">
            <template #icon>
              <NIcon :size="25">
                <RefreshCircleOutline />
              </NIcon>
            </template>
          </NButton>
          <div class="no-drag flex justify-center">
            <NPopselect trigger="click">
              <NInput
                v-model:value="searchText"
                placeholder="搜索音乐、专辑、歌手、歌词"
                style="width: 300px"
                size="small"
                clearable>
                <template #prefix>
                  <NIcon :size="20">
                    <Search />
                  </NIcon>
                </template>
              </NInput>
            </NPopselect>
          </div>
        </NFlex>
      </div>
      <div class="no-drag flex justify-center">
        <NDropdown trigger="click"
                   size="small"
                   :options="menuOptions"
                   @select="handleSelect">
          <NAvatar v-if="userStore.isAuthenticated"
                   class="cursor-pointer"
                   round
                   :size="25"
                   :src="userStore.pic"/>
          <NAvatar v-else
                   class="cursor-pointer"
                   round
                   :size="25">
            未登录
          </NAvatar>
        </NDropdown>
      </div>
    </NFlex>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { NAvatar, NButton, NDropdown, NFlex, NIcon, NInput, NPopselect } from 'naive-ui';
import {
  ArrowBackCircleOutline,
  ArrowForwardCircleOutline,
  RefreshCircleOutline,
  Search,
} from '@vicons/ionicons5';
import { useRouter } from 'vue-router';
import { useUserStore } from '@/store';

const searchText = ref('');

const router = useRouter();

const userStore = useUserStore();

const menuOptions = computed(() => {
  if (userStore.isAuthenticated) {
    return [
      {
        label: '个人中心',
        key: 'profile',
      },
      {
        label: '设置',
        key: 'setting',
      },
      {
        type: 'divider',
        key: 'd1',
      },
      {
        label: '退出',
        key: 'logout',
      },
    ];
  }
  return [
    {
        label: '设置',
        key: 'setting',
    },
    {
        type: 'divider',
        key: 'd1',
    },
    {
      label: '登录',
      key: 'login',
    },
  ];
});

const handleSelect = (key: string) => {
  if (key === 'login') {
    router.push('/login');
  }
  if (key === 'profile') {
    router.push('/profile');
  }
  if (key === 'setting') {
    router.push('/setting');
  }
  if (key === 'logout') {
    logout();
  }
};

const logout = () => {
  window.$dialog.warning({
      title: '退出登录',
      content: '确定要退出登录吗？',
      positiveText: '确定',
      negativeText: '取消',
      onPositiveClick: () => {
        userStore.clearUserInfo();
      },
  });
};
</script>

<style scoped>
.titlebar {
  height: 50px;
}

.content {
  padding: 0 10px;
  height: 50px;
}

.drag {
  app-region: drag;
  -webkit-app-region: drag;
}

.no-drag {
  app-region: no-drag;
  -webkit-app-region: no-drag;
}

.nav {
  margin-left: 280px;
}
</style>
