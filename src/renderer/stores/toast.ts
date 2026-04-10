import { defineStore } from 'pinia';

export type ToastTone = 'info' | 'success' | 'warning' | 'danger';

export interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
  duration: number;
}

let toastId = 0;

export const useToastStore = defineStore('toast', {
  state: () => ({
    items: [] as ToastItem[],
  }),
  actions: {
    show(message: string, tone: ToastTone = 'info', duration = 2600) {
      const normalized = String(message ?? '').trim();
      if (!normalized) return 0;
      const id = ++toastId;
      this.items.push({ id, message: normalized, tone, duration });
      window.setTimeout(() => {
        this.remove(id);
      }, duration);
      return id;
    },
    remove(id: number) {
      this.items = this.items.filter((item) => item.id !== id);
    },
    info(message: string, duration?: number) {
      return this.show(message, 'info', duration);
    },
    loadFailed(target = '内容', duration?: number) {
      return this.warning(`${target}加载失败，请稍后重试`, duration);
    },
    actionFailed(action = '操作', duration?: number) {
      return this.warning(`${action}失败，请稍后重试`, duration);
    },
    loginRequired(action = '操作', duration?: number) {
      return this.info(`请先登录后再${action}`, duration);
    },
    navigateFailed(duration?: number) {
      return this.warning('页面跳转失败，请稍后重试', duration);
    },
    unavailable(target = '当前内容', duration?: number) {
      return this.warning(`${target}暂不可用`, duration);
    },
    actionSucceeded(action = '操作', duration?: number) {
      return this.success(`${action}成功`, duration);
    },
    actionCompleted(action = '操作', duration?: number) {
      return this.success(`${action}`, duration);
    },
    success(message: string, duration?: number) {
      return this.show(message, 'success', duration);
    },
    warning(message: string, duration?: number) {
      return this.show(message, 'warning', duration);
    },
    danger(message: string, duration?: number) {
      return this.show(message, 'danger', duration);
    },
  },
});
