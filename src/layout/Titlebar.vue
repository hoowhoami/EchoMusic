<template>
  <div class="titlebar drag">
    <NFlex
      class="content"
      align="center"
      justify="space-between"
    >
      <div class="no-drag nav">
        <NFlex align="center">
          <NButton
            ghost
            text
            :focusable="false"
            @click="router.go(-1)"
          >
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
            @click="router.go(1)"
          >
            <template #icon>
              <NIcon :size="25">
                <ArrowForwardCircleOutline />
              </NIcon>
            </template>
          </NButton>
          <NButton
            ghost
            text
            :focusable="false"
          >
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
                clearable
              >
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
        <NDropdown :options="menuOptions">
          <NAvatar
            round
            :size="25"
            :src="userStore.pic"
            @click="logout"
          >
            {{ userStore.nickname }}
          </NAvatar>  
        </NDropdown>
      </div>
    </NFlex>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
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

const menuOptions = ref([
  {
    label: '退出',
    key: 'logout',
  },
]);

const logout = () => {
  console.log('logout');
  userStore.clearUserInfo();
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
