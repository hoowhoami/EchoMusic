import { NIcon } from 'naive-ui';
import { Component, h } from 'vue';

export const renderIcon = (icon: Component, size: number = 18) => {
  const style = {
    transform: 'translateY(-1px)',
  };
  return () => h(NIcon, { size, style }, { default: () => h(icon) });
};
