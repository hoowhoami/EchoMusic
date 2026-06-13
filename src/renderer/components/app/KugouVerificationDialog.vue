<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Dialog from '@/components/ui/Dialog.vue';
import Button from '@/components/ui/Button.vue';
import Input from '@/components/ui/Input.vue';
import {
  cancelKugouVerification,
  getKugouCaptchaProvider,
  KUGOU_CAPTCHA_PROVIDER_NAMES,
  kugouVerificationState,
  submitKugouVerification,
} from '@/utils/kugouVerification';
import { iconShield, iconSmartphone } from '@/icons';

type TencentCaptchaResult = {
  ret: number;
  ticket?: string;
  randstr?: string;
};

type TencentCaptchaInstance = {
  show: () => void;
};

type TencentCaptchaConstructor = new (
  appId: string,
  callback: (result: TencentCaptchaResult) => void,
  options?: Record<string, unknown>,
) => TencentCaptchaInstance;

const smsCode = ref('');
const captchaLoading = ref(false);
let tencentCaptchaPromise: Promise<TencentCaptchaConstructor> | null = null;

const verifyType = computed(() => Number(kugouVerificationState.verifyInfo?.v_type || 23));
const txAppId = computed(() => String(kugouVerificationState.verifyInfo?.txappid || '').trim());
const provider = computed(() => getKugouCaptchaProvider(kugouVerificationState.verifyInfo));
const providerName = computed(() => KUGOU_CAPTCHA_PROVIDER_NAMES[provider.value]);
const isOpen = computed(() => kugouVerificationState.open);
const isLoading = computed(() => kugouVerificationState.status === 'loading');
const isVerifying = computed(() => kugouVerificationState.status === 'verifying');
const isTencentCaptcha = computed(() => provider.value === 'TX');
const isSmsCaptcha = computed(() => provider.value === 'SMS');
const isUnsupported = computed(
  () =>
    Boolean(kugouVerificationState.verifyInfo) && !isTencentCaptcha.value && !isSmsCaptcha.value,
);
const title = computed(() => (isSmsCaptcha.value ? '短信安全验证' : '安全验证'));
const description = computed(() => {
  if (isLoading.value) return '正在准备验证';
  if (isSmsCaptcha.value) return '请输入酷狗下发的验证码';
  if (isTencentCaptcha.value) return '完成验证后将继续刚才的操作';
  return `当前需要${providerName.value}，暂不支持自动处理`;
});

const loadTencentCaptcha = () => {
  if ((window as any).TencentCaptcha) {
    return Promise.resolve((window as any).TencentCaptcha as TencentCaptchaConstructor);
  }

  if (!tencentCaptchaPromise) {
    tencentCaptchaPromise = new Promise<TencentCaptchaConstructor>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://turing.captcha.qcloud.com/TCaptcha.js';
      script.async = true;
      script.onload = () => {
        const Captcha = (window as any).TencentCaptcha as TencentCaptchaConstructor | undefined;
        if (Captcha) resolve(Captcha);
        else reject(new Error('腾讯验证码加载失败'));
      };
      script.onerror = () => reject(new Error('腾讯验证码加载失败'));
      document.head.appendChild(script);
    }).catch((error) => {
      tencentCaptchaPromise = null;
      throw error;
    });
  }

  return tencentCaptchaPromise!;
};

const startTencentCaptcha = async () => {
  if (!txAppId.value) {
    kugouVerificationState.error = '缺少腾讯验证码配置';
    return;
  }

  captchaLoading.value = true;
  kugouVerificationState.error = '';

  try {
    const TencentCaptcha = await loadTencentCaptcha();
    const captcha = new TencentCaptcha(
      txAppId.value,
      (result) => {
        captchaLoading.value = false;
        if (result.ret !== 0) {
          kugouVerificationState.error = '验证已取消';
          return;
        }

        const verifyCode = `KGCodeTX|${JSON.stringify({
          ticket: result.ticket,
          randstr: result.randstr,
          txappid: txAppId.value,
        })}`;
        void submitKugouVerification(verifyCode);
      },
      {
        type: '',
        showHeader: false,
      },
    );
    captcha.show();
  } catch (error) {
    captchaLoading.value = false;
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
    if (!open) smsCode.value = '';
  },
);
</script>

<template>
  <Dialog
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
      <div class="verification-icon" :class="{ 'is-sms': isSmsCaptcha }">
        <Icon :icon="isSmsCaptcha ? iconSmartphone : iconShield" width="26" height="26" />
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
          开始验证
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

:global(.dialog-content.kugou-verification-dialog) {
  width: 360px;
}

@keyframes verification-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
