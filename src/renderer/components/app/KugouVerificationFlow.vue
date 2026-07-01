<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import Dialog from '@/components/ui/Dialog.vue';
import Button from '@/components/ui/Button.vue';
import Input from '@/components/ui/Input.vue';
import {
  awaitKugouLoginVerification,
  cancelKugouVerification,
  getKugouCaptchaProvider,
  KUGOU_CAPTCHA_PROVIDER_NAMES,
  kugouVerificationState,
  submitKugouVerification,
} from '@/utils/kugouVerification';
import { iconShield, iconSmartphone, iconUser } from '@/icons';

type TencentCaptchaResult = {
  ret: number;
  ticket?: string;
  randstr?: string;
};

type TencentCaptchaInstance = {
  show: () => void;
  hide?: () => void;
  destroy?: () => void;
};

type TencentCaptchaConstructor = new (
  appId: string,
  callback: (result: TencentCaptchaResult) => void,
  options?: Record<string, unknown>,
) => TencentCaptchaInstance;

const smsCode = ref('');
const captchaLoading = ref(false);
const captchaPanelOpen = ref(false);
const router = useRouter();
let tencentCaptchaPromise: Promise<TencentCaptchaConstructor> | null = null;
let captchaLoadTimer: number | null = null;
let activeTencentCaptcha: TencentCaptchaInstance | null = null;
let captchaSessionId = 0;
let captchaPositionObserver: MutationObserver | null = null;
let captchaPositionTimers: number[] = [];

const verifyType = computed(() => Number(kugouVerificationState.verifyInfo?.v_type || 23));
const txAppId = computed(() => String(kugouVerificationState.verifyInfo?.txappid || '').trim());
const provider = computed(() => getKugouCaptchaProvider(kugouVerificationState.verifyInfo));
const providerName = computed(() => KUGOU_CAPTCHA_PROVIDER_NAMES[provider.value]);
const isOpen = computed(() => kugouVerificationState.open);
const isLoading = computed(() => kugouVerificationState.status === 'loading');
const isVerifying = computed(() => kugouVerificationState.status === 'verifying');
const isTencentCaptcha = computed(() => provider.value === 'TX');
const isSmsCaptcha = computed(() => provider.value === 'SMS');
const isLoginVerification = computed(() => provider.value === 'LOGIN');
const isUnsupported = computed(
  () =>
    Boolean(kugouVerificationState.verifyInfo) &&
    !isTencentCaptcha.value &&
    !isSmsCaptcha.value &&
    !isLoginVerification.value,
);
const loginMessage = computed(() =>
  String(kugouVerificationState.verifyInfo?.show?.msg || '').trim(),
);
const title = computed(() => {
  if (isSmsCaptcha.value) return '短信安全验证';
  if (isLoginVerification.value) return '登录确认';
  return '安全验证';
});
const tencentActionText = computed(() => (kugouVerificationState.error ? '重新验证' : '开始验证'));
const description = computed(() => {
  if (isLoading.value) return '正在准备验证';
  if (isSmsCaptcha.value) return '请输入酷狗下发的验证码';
  if (isLoginVerification.value) return loginMessage.value || '请登录账号以确认身份';
  if (isTencentCaptcha.value) return '完成验证后将继续刚才的操作';
  return `当前需要${providerName.value}，暂不支持自动处理`;
});

const clearCaptchaLoadTimer = () => {
  if (captchaLoadTimer !== null) {
    window.clearTimeout(captchaLoadTimer);
    captchaLoadTimer = null;
  }
};

const isTencentCaptchaFrame = (frame: HTMLIFrameElement) => {
  const src = String(frame.src || '').toLowerCase();
  return /captcha|tcaptcha|turing|ssl\.captcha|captcha\.qq|tencent/.test(src);
};

const hasTencentCaptchaFrame = (element: HTMLElement) => {
  if (element instanceof HTMLIFrameElement && isTencentCaptchaFrame(element)) return true;
  return Array.from(element.querySelectorAll('iframe')).some((frame) =>
    isTencentCaptchaFrame(frame),
  );
};

const isProtectedBodyChild = (element: HTMLElement) => {
  return (
    element.id === 'app' ||
    element.hasAttribute('data-v-app') ||
    element.classList.contains('kugou-captcha-fullscreen-cover')
  );
};

const isTencentCaptchaLikeNode = (element: HTMLElement) => {
  const signature = `${element.id || ''} ${
    typeof element.className === 'string' ? element.className : ''
  }`.toLowerCase();
  return /tcaptcha|tencentcaptcha|turing/.test(signature) || hasTencentCaptchaFrame(element);
};

const removeLingeringTencentCaptchaNodes = () => {
  for (const child of Array.from(document.body.children)) {
    if (!(child instanceof HTMLElement)) continue;
    if (isProtectedBodyChild(child)) continue;
    if (['SCRIPT', 'STYLE', 'LINK'].includes(child.tagName)) continue;
    if (isTencentCaptchaLikeNode(child)) child.remove();
  }
};

const setImportantStyle = (element: HTMLElement, property: string, value: string) => {
  if (
    element.style.getPropertyValue(property) === value &&
    element.style.getPropertyPriority(property) === 'important'
  ) {
    return;
  }
  element.style.setProperty(property, value, 'important');
};

const getTencentCaptchaPanelNodes = () => {
  const nodes = new Set<HTMLElement>();

  for (const frame of Array.from(document.body.querySelectorAll('iframe'))) {
    if (!isTencentCaptchaFrame(frame)) continue;

    const panel = frame.closest(
      '#tcaptcha_transform_dy, [id^="tcaptcha_transform"], .tcaptcha-transform',
    );

    if (panel instanceof HTMLElement && !isProtectedBodyChild(panel)) {
      nodes.add(panel);
      continue;
    }

    const parent = frame.parentElement;
    if (parent && !isProtectedBodyChild(parent)) {
      nodes.add(parent);
    }
  }

  return Array.from(nodes).filter((node) => {
    for (const child of Array.from(document.body.children)) {
      if (child === node || child.contains(node)) return true;
    }
    return false;
  });
};

const positionTencentCaptchaPanels = () => {
  const safeTop = Math.max(172, Math.min(216, Math.round(window.innerHeight * 0.18)));
  const bottomMargin = 40;
  const verticalOffset = Math.max(116, Math.min(154, Math.round(window.innerHeight * 0.13)));
  const sideMargin = 16;
  const captchaSurfaceBackground =
    'color-mix(in srgb, var(--color-bg-main) 94%, var(--color-text-main) 6%)';

  for (const panel of getTencentCaptchaPanelNodes()) {
    const captchaFrame = Array.from(panel.querySelectorAll('iframe')).find((frame) =>
      isTencentCaptchaFrame(frame),
    );
    const rect = panel.getBoundingClientRect();
    const frameWidth =
      captchaFrame instanceof HTMLElement
        ? parseFloat(captchaFrame.style.width || '') || captchaFrame.offsetWidth
        : 0;
    const frameHeight =
      captchaFrame instanceof HTMLElement
        ? parseFloat(captchaFrame.style.height || '') || captchaFrame.offsetHeight
        : 0;
    const naturalWidth = frameWidth || rect.width || panel.offsetWidth;
    const naturalHeight = frameHeight || rect.height || panel.offsetHeight;
    if (!naturalWidth || !naturalHeight) continue;

    const availableWidth = Math.max(320, window.innerWidth - 96);
    const maxPanelHeight = Math.max(420, window.innerHeight - safeTop - bottomMargin);
    const width = Math.min(naturalWidth, Math.max(360, Math.min(640, availableWidth)));
    const height = Math.min(naturalHeight, Math.min(560, maxPanelHeight));
    const frameOffsetX = Math.max(0, Math.round((naturalWidth - width) / 2));

    const centeredLeft = Math.round((window.innerWidth - width) / 2);
    const centeredTop = Math.round((window.innerHeight - height) / 2);
    const maxTop = Math.max(safeTop, Math.round(window.innerHeight - height - bottomMargin));
    const left = Math.max(sideMargin, centeredLeft);
    const top = Math.min(maxTop, Math.max(safeTop, centeredTop + verticalOffset));

    setImportantStyle(panel, 'position', 'fixed');
    setImportantStyle(panel, 'inset', `${top}px auto auto ${left}px`);
    setImportantStyle(panel, 'top', `${top}px`);
    setImportantStyle(panel, 'left', `${left}px`);
    setImportantStyle(panel, 'right', 'auto');
    setImportantStyle(panel, 'bottom', 'auto');
    setImportantStyle(panel, 'width', `${width}px`);
    setImportantStyle(panel, 'height', `${height}px`);
    setImportantStyle(panel, 'margin', '0');
    setImportantStyle(panel, 'transform', 'none');
    setImportantStyle(panel, 'z-index', '2147482000');
    setImportantStyle(panel, 'overflow', 'hidden');
    setImportantStyle(panel, 'border-radius', '18px');
    setImportantStyle(panel, 'background', captchaSurfaceBackground);
    setImportantStyle(panel, 'border', '0');
    setImportantStyle(panel, 'box-shadow', 'none');

    for (const frame of Array.from(panel.querySelectorAll('iframe'))) {
      if (frame instanceof HTMLElement) {
        setImportantStyle(frame, 'position', 'relative');
        setImportantStyle(frame, 'left', `${-frameOffsetX}px`);
        setImportantStyle(frame, 'margin', '0');
        setImportantStyle(frame, 'max-width', 'none');
        setImportantStyle(frame, 'width', `${naturalWidth}px`);
        setImportantStyle(frame, 'height', `${naturalHeight}px`);
        setImportantStyle(frame, 'border-radius', '16px');
        setImportantStyle(frame, 'border', '0');
        setImportantStyle(frame, 'box-shadow', 'none');
        setImportantStyle(frame, 'background', captchaSurfaceBackground);
      }
    }

    for (const title of Array.from(
      panel.querySelectorAll('#transform_header, .transform-header'),
    )) {
      if (title instanceof HTMLElement) {
        setImportantStyle(title, 'color', 'var(--color-text-main)');
      }
    }

    for (const text of Array.from(panel.querySelectorAll('#transform_text, .transform-text'))) {
      if (text instanceof HTMLElement) {
        setImportantStyle(text, 'color', 'var(--color-text-secondary)');
      }
    }
  }
};

const stopTencentCaptchaPositioning = () => {
  captchaPositionObserver?.disconnect();
  captchaPositionObserver = null;
  for (const timer of captchaPositionTimers) window.clearTimeout(timer);
  captchaPositionTimers = [];
};

const startTencentCaptchaPositioning = (sessionId: number) => {
  stopTencentCaptchaPositioning();

  const run = () => {
    if (sessionId !== captchaSessionId || !captchaPanelOpen.value) return;
    positionTencentCaptchaPanels();
  };

  run();
  for (const delay of [80, 180, 360, 700, 1200, 2000]) {
    captchaPositionTimers.push(window.setTimeout(run, delay));
  }

  captchaPositionObserver = new MutationObserver(run);
  captchaPositionObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style'],
  });
};

const destroyActiveTencentCaptcha = () => {
  const captcha = activeTencentCaptcha;
  activeTencentCaptcha = null;
  if (!captcha) return;

  try {
    captcha.hide?.();
  } catch {
    // 不同版本腾讯 SDK 方法不完全一致，清理失败时继续移除残留 DOM。
  }

  try {
    captcha.destroy?.();
  } catch {
    // 同上。
  }
};

const resetTencentCaptcha = () => {
  captchaSessionId += 1;
  captchaLoading.value = false;
  stopTencentCaptchaPositioning();
  clearCaptchaLoadTimer();
  destroyActiveTencentCaptcha();
  removeLingeringTencentCaptchaNodes();
  captchaPanelOpen.value = false;
};

const cancelCurrentVerification = () => {
  resetTencentCaptcha();
  cancelKugouVerification();
};

const startLoginVerification = async () => {
  resetTencentCaptcha();
  try {
    awaitKugouLoginVerification();
    const currentRoute = router.currentRoute.value;
    const from =
      currentRoute.name === 'login' ? '/main/home' : currentRoute.fullPath || '/main/home';
    await router.push({
      name: 'login',
      query: { from },
    });
  } catch (error) {
    kugouVerificationState.status = 'ready';
    kugouVerificationState.error =
      error instanceof Error ? error.message : '无法打开登录页，请稍后重试';
  }
};

const loadTencentCaptcha = () => {
  if ((window as any).TencentCaptcha) {
    return Promise.resolve((window as any).TencentCaptcha as TencentCaptchaConstructor);
  }

  if (!tencentCaptchaPromise) {
    tencentCaptchaPromise = new Promise<TencentCaptchaConstructor>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://turing.captcha.qcloud.com/TCaptcha.js';
      script.async = true;
      captchaLoadTimer = window.setTimeout(() => {
        script.remove();
        reject(new Error('腾讯验证码加载超时，请检查网络后重试'));
      }, 10000);
      script.onload = () => {
        clearCaptchaLoadTimer();
        const Captcha = (window as any).TencentCaptcha as TencentCaptchaConstructor | undefined;
        if (Captcha) resolve(Captcha);
        else reject(new Error('腾讯验证码加载失败'));
      };
      script.onerror = () => {
        clearCaptchaLoadTimer();
        reject(new Error('腾讯验证码加载失败'));
      };
      document.head.appendChild(script);
    }).catch((error) => {
      tencentCaptchaPromise = null;
      throw error;
    });
  }

  return tencentCaptchaPromise!;
};

const handleTencentCaptchaResult = async (result: TencentCaptchaResult, sessionId: number) => {
  if (sessionId !== captchaSessionId) return;

  if (result.ret !== 0) {
    cancelCurrentVerification();
    return;
  }

  const verifyCode = `KGCodeTX|${JSON.stringify({
    ticket: result.ticket,
    randstr: result.randstr,
    txappid: txAppId.value,
  })}`;

  try {
    captchaLoading.value = true;
    await submitKugouVerification(verifyCode);
  } catch (error) {
    if (!isOpen.value) return;
    kugouVerificationState.status = 'ready';
    kugouVerificationState.error = error instanceof Error ? error.message : '验证失败，请重新验证';
  } finally {
    resetTencentCaptcha();
  }
};

const startTencentCaptcha = async () => {
  if (!txAppId.value) {
    kugouVerificationState.error = '缺少腾讯验证码配置';
    return;
  }

  resetTencentCaptcha();
  const sessionId = captchaSessionId + 1;
  captchaSessionId = sessionId;
  captchaLoading.value = true;
  captchaPanelOpen.value = true;
  kugouVerificationState.error = '';

  try {
    await nextTick();
    const TencentCaptcha = await loadTencentCaptcha();
    if (sessionId !== captchaSessionId) return;

    const captcha = new TencentCaptcha(
      txAppId.value,
      (result) => {
        void handleTencentCaptchaResult(result, sessionId);
      },
      {
        type: '',
        showHeader: false,
        ready: () => {},
      },
    );

    if (sessionId !== captchaSessionId) {
      captcha.destroy?.();
      return;
    }

    activeTencentCaptcha = captcha;
    captcha.show();
    startTencentCaptchaPositioning(sessionId);
    window.setTimeout(() => {
      if (sessionId === captchaSessionId) captchaLoading.value = false;
    }, 1000);
  } catch (error) {
    if (sessionId !== captchaSessionId) return;
    resetTencentCaptcha();
    kugouVerificationState.error =
      error instanceof Error ? error.message : '腾讯验证码加载失败，请稍后重试';
  }
};

const submitSmsCode = () => {
  void submitKugouVerification(smsCode.value);
};

watch(
  () => kugouVerificationState.open,
  (open) => {
    if (!open) {
      smsCode.value = '';
      resetTencentCaptcha();
    }
  },
);

onBeforeUnmount(resetTencentCaptcha);
</script>

<template>
  <Dialog
    v-if="!captchaPanelOpen"
    :open="isOpen"
    :title="title"
    :description="description"
    :show-close="false"
    :close-on-escape="false"
    :close-on-interact-outside="false"
    content-class="kugou-verification-dialog"
    @update:open="(value) => !value && cancelKugouVerification()"
  >
    <div class="verification-shell">
      <div
        class="verification-icon"
        :class="{ 'is-sms': isSmsCaptcha, 'is-login': isLoginVerification }"
      >
        <Icon
          :icon="isSmsCaptcha ? iconSmartphone : isLoginVerification ? iconUser : iconShield"
          width="26"
          height="26"
        />
      </div>

      <div v-if="isLoading" class="verification-loading">
        <div class="verification-spinner"></div>
      </div>

      <template v-else-if="isTencentCaptcha">
        <Button
          class="w-full"
          :loading="captchaLoading || isVerifying"
          :disabled="isVerifying"
          @click="startTencentCaptcha"
        >
          {{ tencentActionText }}
        </Button>
      </template>

      <template v-else-if="isSmsCaptcha">
        <Input
          v-model="smsCode"
          type="text"
          placeholder="验证码"
          input-class="text-center tracking-[4px] pr-6"
          :show-clear="false"
          @keyup.enter="submitSmsCode"
        />
        <Button
          class="w-full"
          :loading="isVerifying"
          :disabled="!smsCode.trim() || isVerifying"
          @click="submitSmsCode"
        >
          提交验证
        </Button>
      </template>

      <template v-else-if="isLoginVerification">
        <Button class="w-full" @click="startLoginVerification"> 去登录确认 </Button>
      </template>

      <p v-if="kugouVerificationState.error" class="verification-error">
        {{ kugouVerificationState.error }}
      </p>
      <p v-else-if="isUnsupported" class="verification-error">
        验证类型：{{ providerName }} / v_type={{ verifyType }}
      </p>
    </div>

    <template #footer>
      <Button
        variant="ghost"
        class="w-full"
        :disabled="isVerifying"
        @click="cancelKugouVerification"
      >
        取消
      </Button>
    </template>
  </Dialog>

  <Teleport to="body">
    <div
      v-if="isOpen && isTencentCaptcha && captchaPanelOpen"
      class="kugou-captcha-fullscreen-cover"
    >
      <div class="kugou-captcha-fullscreen-header">
        <h3 class="kugou-captcha-fullscreen-title">安全验证</h3>
        <Button variant="secondary" :disabled="isVerifying" @click="cancelCurrentVerification">
          退出验证
        </Button>
      </div>
      <div v-if="captchaLoading" class="kugou-captcha-fullscreen-loading">
        <div class="verification-spinner"></div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.verification-shell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 4px 0 2px;
}

.verification-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 58px;
  height: 58px;
  border-radius: 999px;
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
}

.verification-icon.is-sms {
  color: #07c160;
  background: color-mix(in srgb, #07c160 12%, transparent);
}

.verification-icon.is-login {
  color: var(--color-text-main);
  background: color-mix(in srgb, var(--color-text-main) 10%, transparent);
}

.verification-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 56px;
}

.verification-spinner {
  width: 28px;
  height: 28px;
  border: 3px solid color-mix(in srgb, var(--color-primary) 18%, transparent);
  border-top-color: var(--color-primary);
  border-radius: 999px;
  animation: verification-spin 0.8s linear infinite;
}

.verification-error {
  min-height: 18px;
  font-size: 12px;
  font-weight: 700;
  line-height: 1.5;
  color: var(--state-danger);
  text-align: center;
}

.kugou-captcha-fullscreen-cover {
  position: fixed;
  inset: 0;
  z-index: 1400;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 44px 48px 40px;
  background: color-mix(in srgb, var(--color-bg-main) 94%, var(--color-text-main) 6%);
  backdrop-filter: blur(8px);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--color-bg-elevated) 68%, transparent);
  pointer-events: none;
  -webkit-app-region: no-drag;
}

.kugou-captcha-fullscreen-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  pointer-events: auto;
}

.kugou-captcha-fullscreen-title {
  margin: 0;
  font-size: 24px;
  font-weight: 800;
  line-height: 1.2;
  color: var(--color-text-main);
}

.kugou-captcha-fullscreen-description {
  margin: 10px 0 0;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.5;
  color: var(--color-text-secondary);
}

.kugou-captcha-fullscreen-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}

:global(.dialog-content.kugou-verification-dialog) {
  width: 360px;
}

:global(.dialog-content.kugou-verification-dialog .dialog-body) {
  padding-right: 1.5rem;
}

@keyframes verification-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
