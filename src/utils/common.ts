import { NIcon } from 'naive-ui';
import { Component, h } from 'vue';

export const renderIcon = (icon: Component, size: number = 18) => {
  const style = {
    transform: 'translateY(-1px)',
  };
  return () => h(NIcon, { size, style }, { default: () => h(icon) });
};

export const formatBytes = (bytes: number, space: boolean = true) => {
  if (!bytes) {
    return '0' + (space ? ' ' : '') + 'B';
  }
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return parseFloat((bytes / Math.pow(1024, i)).toFixed(2)) + (space ? ' ' : '') + sizes[i];
};

// 环境判断
export const isDev = import.meta.env.MODE === 'development' || import.meta.env.DEV;
