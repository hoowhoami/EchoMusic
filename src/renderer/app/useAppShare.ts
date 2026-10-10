import { ref, watch, type Ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useToastStore } from '@/stores/toast';
import { logger } from '@/utils/logger';
import {
  navigateToShareTarget,
  SHARE_RESOLVE_ROUTE_NAME,
  SHARE_COPIED_EVENT,
  type ShareCopiedEventDetail,
} from '@/utils/share';
import { extractShareTarget, getShareResourceLabel, type ShareTarget } from '../../shared/share';
import type { AppLifetime } from './lifetime';

export function useAppShare(isMiniPlayerRoute: Readonly<Ref<boolean>>, lifetime: AppLifetime) {
  const route = useRoute();
  const router = useRouter();
  const toastStore = useToastStore();
  const pendingShareTarget = ref<ShareTarget | null>(null);
  let clipboardShareCheckTimer: number | null = null;
  let lastHandledClipboardText = '';
  let isCheckingClipboardShare = false;
  const openShareTarget = (target: ShareTarget) => {
    if (!lifetime.active) return;
    if (route.name === 'loading') {
      pendingShareTarget.value = target;
      return;
    }
    if (!navigateToShareTarget(router, target)) {
      logger.warn('App', 'Invalid share target skipped', target);
      void router.push({
        name: SHARE_RESOLVE_ROUTE_NAME,
        query: {
          type: target.type,
          id: target.id,
          reason: 'invalid',
        },
      });
    }
  };

  const normalizeClipboardText = (value: unknown) => String(value ?? '').trim();

  const handleShareCopied = (event: Event) => {
    const detail = (event as CustomEvent<ShareCopiedEventDetail>).detail;
    const text = normalizeClipboardText(detail?.text);
    if (detail?.target?.type && detail.target.id && text) {
      lastHandledClipboardText = text;
    }
  };

  const checkClipboardShareTarget = async () => {
    if (isMiniPlayerRoute.value || isCheckingClipboardShare) return;
    const readClipboard = window.electron?.share?.readClipboard;
    if (!readClipboard) return;

    isCheckingClipboardShare = true;
    try {
      const text = await readClipboard();
      if (!lifetime.active) return;
      const normalizedText = normalizeClipboardText(text);
      const target = extractShareTarget(text);
      if (!target) {
        lastHandledClipboardText = '';
        return;
      }

      if (normalizedText && normalizedText === lastHandledClipboardText) return;
      lastHandledClipboardText = normalizedText;

      const label = getShareResourceLabel(target.type);
      toastStore.showAction(`检测到 EchoMusic ${label}分享`, {
        label: '打开',
        handler: () => openShareTarget(target),
      });
    } catch (error) {
      logger.debug('App', 'Failed to inspect clipboard share link', error);
    } finally {
      isCheckingClipboardShare = false;
    }
  };

  const scheduleClipboardShareCheck = () => {
    if (clipboardShareCheckTimer !== null) {
      window.clearTimeout(clipboardShareCheckTimer);
    }
    clipboardShareCheckTimer = window.setTimeout(() => {
      clipboardShareCheckTimer = null;
      void checkClipboardShareTarget();
    }, 350);
  };

  const flushPendingShareTarget = () => {
    if (route.name === 'loading' || !pendingShareTarget.value) return;
    const target = pendingShareTarget.value;
    pendingShareTarget.value = null;
    openShareTarget(target);
  };

  watch(() => route.name, flushPendingShareTarget);
  lifetime.add(() => {
    if (clipboardShareCheckTimer !== null) window.clearTimeout(clipboardShareCheckTimer);
    window.removeEventListener('focus', scheduleClipboardShareCheck);
    window.removeEventListener(SHARE_COPIED_EVENT, handleShareCopied);
  });
  return {
    start() {
      lifetime.add(window.electron?.share?.onOpen(openShareTarget));
      window.addEventListener('focus', scheduleClipboardShareCheck);
      window.addEventListener(SHARE_COPIED_EVENT, handleShareCopied);
    },
    scheduleClipboardShareCheck,
  };
}
