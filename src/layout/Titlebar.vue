<template>
  <div class="titlebar drag">
    <div class="left">
      <div>前进/后退/刷新</div>
    </div>

    <div class="center no-drag">
      <InputSearch
        v-model:value="searchText"
        placeholder="搜索音乐、歌手、歌词、用户"
        style="width: 300px"
      />
    </div>

    <div class="right no-drag">
      <a-space size="large">
        <a-tooltip title="设置">
          <setting-outlined class="icon" />
        </a-tooltip>

        <a-dropdown>
          <a-avatar class="avatar" size="small">
            <template #icon>
              <user-outlined />
            </template>
          </a-avatar>
          <template #overlay>
            <a-menu>
              <a-menu-item key="profile"> 个人中心 </a-menu-item>
              <a-menu-item key="settings"> 账号设置 </a-menu-item>
              <a-menu-divider />
              <a-menu-item key="logout"> 退出登录 </a-menu-item>
            </a-menu>
          </template>
        </a-dropdown>
      </a-space>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { UserOutlined, SettingOutlined } from '@ant-design/icons-vue';
import { InputSearch } from 'ant-design-vue';

const searchText = ref('');
</script>

<style scoped>
.titlebar {
  height: 40px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.drag {
  app-region: drag;
  -webkit-app-region: drag;
}

.no-drag {
  app-region: no-drag;
  -webkit-app-region: no-drag;
}

.center {
  height: 32px;
}
</style>
