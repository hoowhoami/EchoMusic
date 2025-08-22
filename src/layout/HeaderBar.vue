<template>
  <div class="header-bar">
    <div class="left">
      <menu-unfold-outlined
        v-if="collapsed"
        class="trigger"
        @click="$emit('toggle')"
      />
      <menu-fold-outlined
        v-else
        class="trigger"
        @click="$emit('toggle')"
      />
      
      <a-breadcrumb class="breadcrumb">
        <a-breadcrumb-item>首页</a-breadcrumb-item>
        <a-breadcrumb-item>发现音乐</a-breadcrumb-item>
      </a-breadcrumb>
    </div>

    <div class="center">
      <a-input-search
        v-model:value="searchText"
        placeholder="搜索音乐、歌手、歌词、用户"
        style="width: 300px"
        @search="onSearch"
      />
    </div>

    <div class="right">
      <a-space size="large">
        <a-tooltip title="皮肤">
          <skin-outlined class="icon" />
        </a-tooltip>
        
        <a-tooltip title="设置">
          <setting-outlined class="icon" />
        </a-tooltip>
        
        <a-tooltip title="消息">
          <bell-outlined class="icon" />
        </a-tooltip>
        
        <a-dropdown>
          <a-avatar class="avatar" size="small">
            <template #icon>
              <user-outlined />
            </template>
          </a-avatar>
          <template #overlay>
            <a-menu>
              <a-menu-item key="profile">个人中心</a-menu-item>
              <a-menu-item key="settings">账号设置</a-menu-item>
              <a-menu-divider />
              <a-menu-item key="logout">退出登录</a-menu-item>
            </a-menu>
          </template>
        </a-dropdown>
      </a-space>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import {
  MenuUnfoldOutlined,
  MenuFoldOutlined,
  UserOutlined,
  SkinOutlined,
  SettingOutlined,
  BellOutlined,
} from '@ant-design/icons-vue';

defineProps<{
  collapsed: boolean;
}>();

defineEmits<{
  toggle: [];
}>();

const searchText = ref('');

const onSearch = (value: string) => {
  console.log('Search:', value);
};
</script>

<style scoped>
.header-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 100%;
  padding: 0 24px;
}

.left {
  display: flex;
  align-items: center;
}

.trigger {
  font-size: 18px;
  cursor: pointer;
  transition: color 0.3s;
}

.trigger:hover {
  color: #1890ff;
}

.breadcrumb {
  margin-left: 16px;
}

.center {
  flex: 1;
  display: flex;
  justify-content: center;
}

.right {
  display: flex;
  align-items: center;
}

.icon {
  font-size: 16px;
  cursor: pointer;
  color: rgba(0, 0, 0, 0.65);
  transition: color 0.3s;
}

.icon:hover {
  color: #1890ff;
}

.avatar {
  cursor: pointer;
  background-color: #1890ff;
}
</style>