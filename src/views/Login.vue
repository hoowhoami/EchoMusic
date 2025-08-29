<template>
  <div class="login-container">
    <NCard class="login-card">
      <NSpace vertical :size="24">
        <NH1 align="center">欢迎访问 MixMusic</NH1>
        <NText align="center" depth="3" class="login-message"> 您需要登录后才能进行后续操作 </NText>
        <NButton type="primary"
                 size="large"
                 block
                 @click="handleLogin"> 登录 </NButton>
      </NSpace>
    </NCard>
    <NModal style="width: 400px"
            title="登录 MixMusic"
            preset="dialog"
            v-model:show="showModal">
      <NFlex vertical justify="center">
        <NGradientText type="warning"
                       class="mt-2">您的数据始终只存储在酷狗服务和您所使用的设备中</NGradientText>
        <NTabs type="segment" class="mt-2" v-model:value="activeTab">
          <NTabPane name="phone" tab="手机号登录" class="h-[280px]">
            <NForm ref="formRef" :model="formValue" :rules="rules">
              <NFormItem label="手机号" path="mobile">
                <NInput
                  v-model:value="formValue.mobile"
                  placeholder="请输入手机号"
                  :maxlength="11"
                  clearable/>
              </NFormItem>
              <NFormItem label="验证码" path="code">
                <NFlex justify="space-between" class="w-full">
                  <NInputOtp v-model:value="formValue.code" :length="6" />
                  <NButton
                    :disabled="countdown > 0 || !formValue.mobile"
                    @click="sendCaptcha"
                    :loading="captchaLoading || countdown > 0">
                    {{ captchaSentButtonTitle }}
                  </NButton>
                </NFlex>
              </NFormItem>
              <NButton
                type="primary"
                block
                :loading="phoneLoading"
                :disabled="!formValue.mobile || !formValue.code"
                @click="handlePhoneLogin">
                登录
              </NButton>
            </NForm>
          </NTabPane>
          <NTabPane name="qrcode" tab="二维码登录" class="h-[280px]">
            <NFlex vertical align="center" :size="16">
              <NText class="mt-2">{{ qrStatusText }}</NText>
              <NCard class="w-[140px] h-[140px] flex items-center justify-center">
                <NQrCode v-if="qrcode"
                         :value="qrcode"
                         :size="120"
                         :padding="0"
                         class="mt-1" />
                <NSpin v-else :show="!qrcode" class="w-[140px] h-[140px]" />
              </NCard>
              <NButton type="primary" text @click="refreshQrCode"> 刷新二维码 </NButton>
            </NFlex>
          </NTabPane>
        </NTabs>
      </NFlex>
    </NModal>
  </div>
</template>

<script setup lang="ts">
import {
  NCard,
  NModal,
  NSpace,
  NH1,
  NText,
  NButton,
  NFlex,
  NTabs,
  NTabPane,
  NForm,
  NFormItem,
  NInput,
  NInputOtp,
  NGradientText,
  NQrCode,
  NSpin,
  FormInst,
  FormRules,
} from 'naive-ui';
import { ref, reactive, onUnmounted, computed, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useUserStore } from '@/store';

import { captchaSent, loginCellphone, loginQrKey, loginQrCreate, loginQrCheck } from '@/api';

defineOptions({
  name: 'Login',
});

const router = useRouter();
const userStore = useUserStore();

const showModal = ref(false);
const activeTab = ref('phone');
const formRef = ref<FormInst | null>(null);

const formValue = reactive({
  mobile: '',
  code: [],
});

const rules: FormRules = {
  mobile: [
    { key: 'mobile', required: true, message: '请输入手机号', trigger: 'blur' },
    { key: 'mobile', pattern: /^1[3-9]\d{9}$/, message: '请输入正确的手机号', trigger: 'blur' },
  ],
  code: [
    {
      key: 'code',
      required: true,
      message: '请输入验证码',
      trigger: 'blur',
      validator: (_, value: string[] | null) => {
        if (value === null) return false;
        return value.filter(Boolean).length >= 6;
      },
    },
  ],
};

const countdown = ref(0);
const captchaTimer = ref();
const captchaLoading = ref(false);
const captchaSentButtonTitle = computed(() => {
  if (captchaLoading.value) {
    return '发送中';
  }
  if (countdown.value > 0) {
    return `${countdown.value} s`;
  }
  return '获取验证码';
});
const phoneLoading = ref(false);

const qrPollingTimer = ref();

const handleLogin = () => {
  showModal.value = true;
  // phone
  activeTab.value = 'phone';
  formValue.mobile = '';
  formValue.code = [];
  countdown.value = 0;
  captchaLoading.value = false;
  phoneLoading.value = false;
  clearInterval(captchaTimer.value);
  formRef.value?.restoreValidation();
  // qrcode
  captchaTimer.value = null;
  qrStatus.value = -1;
  qrcode.value = '';
  clearInterval(qrPollingTimer.value);
  qrPollingTimer.value = null;
};

watch(activeTab, () => {
  if (activeTab.value === 'qrcode') {
    initQrLogin();
  } else {
    qrStatus.value = -1;
    qrcode.value = '';
    clearInterval(qrPollingTimer.value);
    qrPollingTimer.value = null;
  }
});

watch(showModal, () => {
  if (!showModal.value) {
    activeTab.value = 'phone';
    qrStatus.value = -1;
    qrcode.value = '';
    clearInterval(qrPollingTimer.value);
    qrPollingTimer.value = null;
  }
});

const sendCaptcha = () => {
  if (!formRef.value) return;

  formRef.value.validate(
    async errors => {
      if (!errors) {
        captchaLoading.value = true;
        captchaSent(formValue.mobile)
          .then(() => {
            captchaLoading.value = false;
            window.$message.success('验证码已发送');
            countdown.value = 60;
            captchaTimer.value = setInterval(() => {
              countdown.value--;
              if (countdown.value <= 0) {
                clearInterval(captchaTimer.value);
              }
            }, 1000);
          })
          .catch(() => {
            window.$message.error('验证码发送失败');
          })
          .finally(() => {
            captchaLoading.value = false;
          });
      }
    },
    rule => {
      return rule?.key === 'mobile';
    },
  );
};

const handlePhoneLogin = () => {
  if (!formRef.value) return;

  formRef.value.validate(errors => {
    if (!errors) {
      phoneLoading.value = true;
      const code = formValue.code.join('');
      loginCellphone(formValue.mobile, code)
        .then(response => {
          handleLoginSuccess(response);
        })
        .catch(() => {
          window.$message.error('登录失败');
        })
        .finally(() => {
          phoneLoading.value = false;
        });
    }
  });
};

// QR Code Login
const qrcode = ref('');
const qrStatus = ref(-1);
const qrStatusText = computed(() => {
  switch (qrStatus.value) {
    case 0:
      return '二维码已过期';
    case 1:
      return '等待用户扫码';
    case 2:
      return '请在APP上确认';
    case 4:
      return '登录成功';
    default:
      return '请打开酷狗APP扫码登录';
  }
});

const initQrLogin = () => {
  loginQrKey()
    .then(keyResponse => {
      const { qrcode: key } = keyResponse;
      loginQrCreate(key)
        .then(qrResponse => {
          qrcode.value = qrResponse.url;
          startQrPolling(key);
        })
        .catch(error => {
          console.error('生成二维码失败', error);
          window.$message.error('生成二维码失败');
        });
    })
    .catch(error => {
      console.error('获取二维码key失败', error);
      window.$message.error('获取二维码key失败');
    });
};

const startQrPolling = (key: string) => {
  if (qrPollingTimer.value) {
    clearInterval(qrPollingTimer.value);
  }

  qrPollingTimer.value = setInterval(async () => {
    loginQrCheck(key)
      .then(response => {
        const { status } = response;
        switch (status) {
          case 0:
            qrStatus.value = 0;
            clearInterval(qrPollingTimer.value);
            break;
          case 1:
            qrStatus.value = 1;
            break;
          case 2:
            qrStatus.value = 2;
            break;
          case 4:
            qrStatus.value = 4;
            clearInterval(qrPollingTimer.value);
            handleLoginSuccess(response);
            break;
        }
      })
      .catch(error => {
        clearInterval(qrPollingTimer.value);
        console.error('QR code polling error:', error);
      });
  }, 2000);
};

const refreshQrCode = () => {
  qrcode.value = '';
  qrStatus.value = 0;
  initQrLogin();
};

const handleLoginSuccess = async (data: any) => {
  const { userid, token, username, nickname, pic } = data;
  userStore.setUserInfo({
    userid,
    token,
    username,
    nickname,
    pic,
  });

  window.$message.success('登录成功');
  showModal.value = false;
  router.push('/');
};

onUnmounted(() => {
  if (captchaTimer.value) {
    clearInterval(captchaTimer.value);
  }
  if (qrPollingTimer.value) {
    clearInterval(qrPollingTimer.value);
  }
});
</script>

<style scoped>
.login-container {
  height: calc(100vh - 140px);
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 20px;
}

.login-card {
  width: 100%;
  max-width: 400px;
}

.login-message {
  text-align: center;
  line-height: 1.6;
}
</style>
