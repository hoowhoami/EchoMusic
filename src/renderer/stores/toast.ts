import { defineStore } from 'pinia';

export type ToastTone = 'info' | 'success' | 'warning' | 'danger';
export type ToastPresentation = 'auto' | 'mini' | 'standard';
export type ToastVariant = Exclude<ToastPresentation, 'auto'>;

export interface ToastAction {
  label: string;
  handler: () => void;
}

export interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
  duration: number;
  variant: ToastVariant;
  count: number;
  action?: ToastAction;
}

let toastId = 0;
let activeToastTimer: number | null = null;
let activeToastStartedAt = 0;
let activeToastRemaining = 0;

const MAX_TOAST_ITEMS = 3;
const MINI_MESSAGE_MAX_LENGTH = 30;

const clearActiveToastTimer = () => {
  if (activeToastTimer !== null) {
    window.clearTimeout(activeToastTimer);
    activeToastTimer = null;
  }
  activeToastStartedAt = 0;
};

const resolveToastVariant = (
  message: string,
  action: ToastAction | undefined,
  presentation: ToastPresentation,
): ToastVariant => {
  if (presentation !== 'auto') return presentation;
  if (action || message.includes('\n') || Array.from(message).length > MINI_MESSAGE_MAX_LENGTH) {
    return 'standard';
  }
  return 'mini';
};

const isDuplicateToast = (
  item: ToastItem,
  message: string,
  tone: ToastTone,
  action?: ToastAction,
) => item.message === message && item.tone === tone && item.action?.label === action?.label;

export const useToastStore = defineStore('toast', {
  state: () => ({
    items: [] as ToastItem[],
  }),
  actions: {
    show(
      message: string,
      tone: ToastTone = 'info',
      duration = 2600,
      action?: ToastAction,
      presentation: ToastPresentation = 'auto',
    ) {
      const normalized = String(message ?? '').trim();
      if (!normalized) return 0;

      const duplicate = this.items.find((item) => isDuplicateToast(item, normalized, tone, action));
      if (duplicate) {
        duplicate.count += 1;
        duplicate.duration = duration;
        duplicate.action = action;
        duplicate.variant = resolveToastVariant(normalized, action, presentation);
        if (this.items[0]?.id === duplicate.id) this.scheduleVisibleRemoval(duration);
        return duplicate.id;
      }

      const id = ++toastId;
      const wasEmpty = this.items.length === 0;
      this.items.push({
        id,
        message: normalized,
        tone,
        duration,
        variant: resolveToastVariant(normalized, action, presentation),
        count: 1,
        action,
      });

      if (this.items.length > MAX_TOAST_ITEMS) {
        // 保留正在展示的卡片和最新消息，丢弃最早进入等待队列的提示。
        this.items.splice(1, this.items.length - MAX_TOAST_ITEMS);
      }

      if (wasEmpty) this.scheduleVisibleRemoval(duration);
      return id;
    },
    showAction(message: string, action: ToastAction, tone: ToastTone = 'info', duration = 8000) {
      return this.show(message, tone, duration, action, 'standard');
    },
    mini(message: string, tone: ToastTone = 'info', duration = 2600) {
      return this.show(message, tone, duration, undefined, 'mini');
    },
    standard(message: string, tone: ToastTone = 'info', duration = 4200, action?: ToastAction) {
      return this.show(message, tone, duration, action, 'standard');
    },
    scheduleVisibleRemoval(duration?: number) {
      clearActiveToastTimer();
      const visibleItem = this.items[0];
      const nextDuration = duration ?? visibleItem?.duration ?? 0;
      activeToastRemaining = Math.max(0, nextDuration);
      if (!visibleItem || nextDuration <= 0) return;

      activeToastStartedAt = Date.now();
      activeToastTimer = window.setTimeout(() => {
        activeToastTimer = null;
        this.remove(visibleItem.id);
      }, nextDuration);
    },
    pause(id: number) {
      // Passive notices must expire even if they appear beneath a stationary pointer.
      if (this.items[0]?.id !== id || !this.items[0].action || activeToastTimer === null) return;
      const elapsed = Date.now() - activeToastStartedAt;
      activeToastRemaining = Math.max(0, activeToastRemaining - elapsed);
      clearActiveToastTimer();
    },
    resume(id: number) {
      if (this.items[0]?.id !== id || this.items[0].duration <= 0 || activeToastTimer !== null)
        return;
      if (activeToastRemaining <= 0) {
        this.remove(id);
        return;
      }
      this.scheduleVisibleRemoval(activeToastRemaining);
    },
    remove(id: number) {
      const wasVisible = this.items[0]?.id === id;
      if (wasVisible) clearActiveToastTimer();
      this.items = this.items.filter((item) => item.id !== id);
      if (wasVisible) this.scheduleVisibleRemoval();
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
