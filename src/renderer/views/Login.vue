<script setup lang="ts">
defineOptions({ name: 'login-page' });
import { ref, onMounted, onUnmounted, reactive, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useUserStore } from '@/stores/user';
import {
  getLoginQrKey,
  createLoginQr,
  checkLoginQr,
  sendSmsCode,
  loginBySms,
  loginByPassword,
  createWxLogin,
  checkWxLogin,
  loginByOpenPlat,
  createQqLoginQr,
  checkQqLoginQr,
  type QqLoginQrSession,
} from '@/api/user';
import {
  cancelKugouVerification,
  completeKugouLoginVerification,
  kugouVerificationState,
} from '@/utils/kugouVerification';
import logger from '@/utils/logger';
import { closeTransientView } from '@/utils/navigation';

// 引入封装后的 UI 组件
import Tabs from '@/components/ui/Tabs.vue';
import TabsList from '@/components/ui/TabsList.vue';
import TabsTrigger from '@/components/ui/TabsTrigger.vue';
import TabsContent from '@/components/ui/TabsContent.vue';
import Input from '@/components/ui/Input.vue';
import Button from '@/components/ui/Button.vue';

import OverlayHeader from '@/layouts/OverlayHeader.vue';
import Avatar from '@/components/ui/Avatar.vue';
import Image from '@/components/ui/Image.vue';
import {
  iconBrandQq,
  iconBrandWechat,
  iconCheck,
  iconChevronLeft,
  iconInfo,
  iconQrCode,
  iconRefreshCw,
  iconSmartphone,
  iconUser,
} from '@/icons';

const router = useRouter();
const userStore = useUserStore();

type LoginMethod = 'kugou' | 'sms' | 'account' | 'qq' | 'wechat';

const activeMethod = ref<LoginMethod>('kugou');

const loginMethods = [
  { value: 'kugou', label: '酷狗', icon: iconQrCode, tone: 'primary' },
  { value: 'sms', label: '验证码', icon: iconSmartphone, tone: 'primary' },
  { value: 'account', label: '账号', icon: iconUser, tone: 'primary' },
  { value: 'qq', label: 'QQ', icon: iconBrandQq, tone: 'qq' },
  { value: 'wechat', label: '微信', icon: iconBrandWechat, tone: 'wechat' },
] as const satisfies ReadonlyArray<{
  value: LoginMethod;
  label: string;
  icon: typeof iconQrCode;
  tone: 'primary' | 'qq' | 'wechat';
}>;

let qrSessionVersion = 0;
let isLoginDone = userStore.isLoggedIn;

const invalidateQrSession = () => ++qrSessionVersion;
const isQrSessionActive = (version: number, method: LoginMethod) =>
  !isLoginDone && version === qrSessionVersion && activeMethod.value === method;
const waitForNextPoll = () => new Promise<void>((resolve) => window.setTimeout(resolve, 3000));

const closeLoginPage = async () => {
  if (kugouVerificationState.status === 'awaiting-login') {
    cancelKugouVerification();
  }
  await closeTransientView(router, { query: router.currentRoute.value.query });
};

const getApiErrorBody = (error: unknown): unknown => {
  if (!error || typeof error !== 'object') return null;
  const response = (error as { response?: { body?: unknown } }).response;
  return response?.body ?? null;
};

const getApiErrorMessage = (error: unknown, fallback: string): string => {
  const body = getApiErrorBody(error);
  if (!body || typeof body !== 'object') return fallback;
  const record = body as Record<string, unknown>;
  const message = record.error || record.message || record.msg;
  return typeof message === 'string' && message.trim() ? message : fallback;
};

// --- 酷狗扫码逻辑 ---
const qrKey = ref<string | undefined>(undefined);
const qrUrl = ref<string | undefined>(undefined);
const qrStatus = ref(1);
const isLoadingQr = ref(false);
const qrError = ref('');

const completeLogin = (data: Record<string, unknown>) => {
  isLoginDone = true;
  invalidateQrSession();
  userStore.handleLoginSuccess(data);
  completeKugouLoginVerification();

  void closeTransientView(router, { query: router.currentRoute.value.query });
};

const loadQrCode = async () => {
  if (activeMethod.value !== 'kugou' || isLoginDone) return;
  const sessionVersion = invalidateQrSession();
  isLoadingQr.value = true;
  qrUrl.value = undefined;
  qrKey.value = undefined;
  qrStatus.value = 1;
  qrError.value = '';
  try {
    const keyRes: any = await getLoginQrKey();
    if (!isQrSessionActive(sessionVersion, 'kugou')) return;
    const currentKey = keyRes?.data?.qrcode || keyRes?.data?.key;
    if (keyRes?.status === 1 && currentKey) {
      qrKey.value = currentKey;
      if (keyRes.data.qrcode_img) {
        qrUrl.value = keyRes.data.qrcode_img;
      } else {
        const createRes: any = await createLoginQr(qrKey.value!);
        if (!isQrSessionActive(sessionVersion, 'kugou')) return;
        if (createRes?.status === 1 && createRes?.data?.qrcode_img) {
          qrUrl.value = createRes.data.qrcode_img;
        }
      }
    }
    if (!qrKey.value || !qrUrl.value) {
      throw new Error('Kugou QR response is incomplete');
    }
    void startCheckStatus(sessionVersion);
  } catch (e) {
    if (!isQrSessionActive(sessionVersion, 'kugou')) return;
    logger.error('Login', 'Load QR Error:', e);
    qrError.value = getApiErrorMessage(e, '二维码加载失败，请稍后重试');
    qrStatus.value = 0;
  } finally {
    if (sessionVersion === qrSessionVersion) isLoadingQr.value = false;
  }
};

const startCheckStatus = async (sessionVersion: number) => {
  if (!qrKey.value || !isQrSessionActive(sessionVersion, 'kugou')) return;
  logger.info('Login', 'Starting Kugou QR polling...');

  while (qrKey.value && isQrSessionActive(sessionVersion, 'kugou')) {
    try {
      const res: any = await checkLoginQr(qrKey.value);
      if (!isQrSessionActive(sessionVersion, 'kugou')) break;

      if (res) {
        const status = res.data?.status ?? res.status;
        qrStatus.value = status;
        if (status === 4 && res.data) {
          completeLogin(res.data);
          break;
        } else if (status === 0) {
          break;
        }
      }
    } catch (e) {
      if (!isQrSessionActive(sessionVersion, 'kugou')) break;
      logger.error('Login', 'Check QR Status Error:', e);
      qrError.value = getApiErrorMessage(e, '扫码状态检查失败，请稍后重试');
      qrStatus.value = 0;
      break;
    }
    await waitForNextPoll();
  }
  logger.info('Login', 'Kugou QR polling stopped.');
};

// --- 验证码登录逻辑 ---
const smsData = reactive({
  mobile: '',
  code: '',
  isSending: false,
  countdown: 0,
  error: '',
  accountCandidates: [] as SmsAccountCandidate[],
  pendingUserid: null as number | null,
});
let smsTimer: any = null;

interface SmsAccountCandidate {
  nickname: string;
  pic: string;
  userid: number;
  appid?: number;
  username?: string;
}

const getSmsMultiAccountCandidates = (response: unknown): SmsAccountCandidate[] => {
  const record =
    response && typeof response === 'object' ? (response as Record<string, any>) : undefined;
  if (!record || Number(record.error_code) !== 34175) return [];

  const list = record.data?.info_list;
  if (!Array.isArray(list)) return [];

  return list
    .map((item): SmsAccountCandidate | null => {
      const account = item && typeof item === 'object' ? (item as Record<string, any>) : undefined;
      const userid = Number(account?.userid);
      if (!Number.isFinite(userid) || userid <= 0) return null;
      return {
        userid,
        nickname: String(account?.nickname || account?.username || userid),
        username: account?.username ? String(account.username) : undefined,
        pic: account?.pic ? String(account.pic) : '',
        appid: Number.isFinite(Number(account?.appid)) ? Number(account?.appid) : undefined,
      };
    })
    .filter((item): item is SmsAccountCandidate => Boolean(item));
};

const resetSmsAccountCandidates = () => {
  smsData.accountCandidates = [];
  smsData.pendingUserid = null;
};

const resolveSmsLoginResponse = (res: any): boolean => {
  if (!res || typeof res !== 'object') {
    smsData.error = '登录失败，请稍后重试';
    return false;
  }

  const candidates = getSmsMultiAccountCandidates(res);
  if (candidates.length > 0) {
    smsData.accountCandidates = candidates;
    smsData.error = '';
    return false;
  }

  if (res.status === 1 && res.data?.token) {
    completeLogin(res.data);
    return true;
  }

  smsData.error = res.error || res.message || res.msg || '登录失败，请稍后重试';
  return false;
};

const startCountdown = () => {
  smsData.countdown = 60;
  smsTimer = setInterval(() => {
    smsData.countdown--;
    if (smsData.countdown <= 0) clearInterval(smsTimer);
  }, 1000);
};

const handleSendCode = async () => {
  resetSmsAccountCandidates();
  const mobile = smsData.mobile ? smsData.mobile.toString().trim() : '';
  logger.info('Login', 'Attempting to send code to:', `"${mobile}"`, 'Length:', mobile.length);
  if (!/^1\d{10}$/.test(mobile)) {
    logger.warn('Login', 'Mobile validation failed for:', `"${mobile}"`);
    smsData.error = '请输入正确的手机号';
    return;
  }
  smsData.isSending = true;
  smsData.error = '';
  try {
    const res: any = await sendSmsCode(mobile);
    if (res.status === 1) {
      startCountdown();
    } else {
      smsData.error = res.error || '发送验证码失败，请稍后重试';
    }
  } catch {
    smsData.error = '发送验证码失败，请稍后重试';
  } finally {
    smsData.isSending = false;
  }
};

const handleSmsLogin = async () => {
  const mobile = smsData.mobile.trim();
  if (!mobile || !smsData.code) return;
  resetSmsAccountCandidates();
  smsData.isSending = true;
  try {
    const res: any = await loginBySms(mobile, smsData.code);
    resolveSmsLoginResponse(res);
  } catch (e) {
    const handled = resolveSmsLoginResponse(getApiErrorBody(e));
    if (!handled && smsData.accountCandidates.length === 0) {
      smsData.error = '登录失败，请稍后重试';
    }
  } finally {
    smsData.isSending = false;
  }
};

const handleSmsAccountLogin = async (account: SmsAccountCandidate) => {
  const mobile = smsData.mobile.trim();
  if (!mobile || !smsData.code || smsData.isSending) return;
  smsData.isSending = true;
  smsData.pendingUserid = account.userid;
  smsData.error = '';
  try {
    const res: any = await loginBySms(mobile, smsData.code, account.userid);
    const completed = resolveSmsLoginResponse(res);
    if (!completed) {
      smsData.pendingUserid = null;
    }
  } catch (e) {
    const handled = resolveSmsLoginResponse(getApiErrorBody(e));
    if (!handled && smsData.accountCandidates.length === 0) {
      smsData.error = '登录失败，请稍后重试';
    }
    smsData.pendingUserid = null;
  } finally {
    smsData.isSending = false;
  }
};

// --- 账号密码登录逻辑 ---
const accountData = reactive({
  username: '',
  password: '',
  isSubmitting: false,
  error: '',
});

const handleAccountLogin = async () => {
  const username = accountData.username.trim();
  const password = accountData.password.trim();
  if (!username || !password || accountData.isSubmitting) {
    accountData.error = '请输入用户名和密码';
    return;
  }

  accountData.isSubmitting = true;
  accountData.error = '';

  try {
    const res: any = await loginByPassword(username, password);
    if (res?.status === 1 && res.data) {
      completeLogin(res.data);
    } else {
      accountData.error = res?.error || res?.message || res?.msg || '登录失败，请稍后重试';
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes('已取消安全验证')) {
      logger.warn('Login', 'Account login verification cancelled');
      accountData.error = '已取消安全验证';
    } else if (e instanceof Error && e.message.includes('验证未通过')) {
      logger.warn('Login', 'Account login verification failed');
      accountData.error = e.message;
    } else {
      logger.error('Login', 'Account login failed:', e);
      const response = (e as any)?.response;
      const body = response?.body;
      accountData.error =
        body?.data || body?.error || body?.message || body?.msg || '登录失败，请稍后重试';
    }
  } finally {
    accountData.isSubmitting = false;
  }
};

// --- QQ 扫码逻辑 ---
type QqQrStatus = 'idle' | 'waiting' | 'scanned' | 'expired' | 'error';

const qqQr = reactive({
  url: '',
  session: null as QqLoginQrSession | null,
  status: 'idle' as QqQrStatus,
  message: '',
  isLoading: false,
  error: '',
});

const parseQqQrSession = (response: unknown): QqLoginQrSession | null => {
  if (!response || typeof response !== 'object') return null;
  const record = response as Record<string, unknown>;
  const stringFields = [
    'cookie',
    'qrsig',
    'pt_login_sig',
    'pt_openlogin_data',
    'xlogin_url',
  ] as const;
  if (stringFields.some((field) => typeof record[field] !== 'string' || !record[field]))
    return null;
  if (
    (typeof record.ptqrtoken !== 'string' && typeof record.ptqrtoken !== 'number') ||
    !String(record.ptqrtoken)
  ) {
    return null;
  }
  return {
    cookie: record.cookie as string,
    qrsig: record.qrsig as string,
    ptqrtoken: record.ptqrtoken as string | number,
    pt_login_sig: record.pt_login_sig as string,
    pt_openlogin_data: record.pt_openlogin_data as string,
    xlogin_url: record.xlogin_url as string,
  };
};

const loadQqQr = async () => {
  if (activeMethod.value !== 'qq' || isLoginDone) return;
  const sessionVersion = invalidateQrSession();
  qqQr.isLoading = true;
  qqQr.url = '';
  qqQr.session = null;
  qqQr.status = 'idle';
  qqQr.message = '';
  qqQr.error = '';

  try {
    const response: any = await createQqLoginQr();
    if (!isQrSessionActive(sessionVersion, 'qq')) return;
    const session = parseQqQrSession(response);
    const qrcode = typeof response?.qrcode === 'string' ? response.qrcode : '';
    if (!session || !qrcode) throw new Error('QQ QR response is incomplete');

    qqQr.session = session;
    qqQr.url = qrcode.startsWith('data:') ? qrcode : `data:image/png;base64,${qrcode}`;
    qqQr.status = 'waiting';
    qqQr.message = '等待 QQ 扫码';
    void startCheckQqStatus(sessionVersion);
  } catch (e) {
    if (!isQrSessionActive(sessionVersion, 'qq')) return;
    logger.error('Login', 'Load QQ QR Error:', e);
    qqQr.error = getApiErrorMessage(e, 'QQ 二维码加载失败，请稍后重试');
    qqQr.status = 'error';
  } finally {
    if (sessionVersion === qrSessionVersion) qqQr.isLoading = false;
  }
};

const startCheckQqStatus = async (sessionVersion: number) => {
  const session = qqQr.session;
  if (!session || !isQrSessionActive(sessionVersion, 'qq')) return;
  logger.info('Login', 'Starting QQ QR polling...');

  while (isQrSessionActive(sessionVersion, 'qq')) {
    try {
      const response: any = await checkQqLoginQr(session);
      if (!isQrSessionActive(sessionVersion, 'qq')) break;

      if (Number(response?.status) === 1 && response?.data?.token) {
        completeLogin(response.data);
        break;
      }

      const status = String(response?.status ?? '');
      const message = typeof response?.msg === 'string' ? response.msg : '';
      if (status === 'wait' || status === '66') {
        qqQr.status = 'waiting';
        qqQr.message = message || '等待 QQ 扫码';
      } else if (status === '67') {
        qqQr.status = 'scanned';
        qqQr.message = message || '已扫码，请在 QQ 中确认';
      } else if (status === 'expired' || status === '65') {
        qqQr.status = 'expired';
        qqQr.message = message || '二维码已过期';
        break;
      } else {
        qqQr.status = 'error';
        qqQr.error = message || 'QQ 扫码状态异常，请重新加载';
        break;
      }
    } catch (e) {
      if (!isQrSessionActive(sessionVersion, 'qq')) break;
      logger.error('Login', 'Check QQ QR Status Error:', e);
      qqQr.error = getApiErrorMessage(e, 'QQ 登录状态检查失败，请稍后重试');
      qqQr.status = 'error';
      break;
    }
    await waitForNextPoll();
  }
  logger.info('Login', 'QQ QR polling stopped.');
};

// --- 微信扫码逻辑 ---
const wxQr = reactive({
  url: '',
  uuid: '',
  status: 0, // 0: 等待, 1: 扫描, 2: 确认, 3: 过期
  isLoading: false,
  error: '',
});

const loadWxQr = async () => {
  if (activeMethod.value !== 'wechat' || isLoginDone) return;
  const sessionVersion = invalidateQrSession();
  wxQr.isLoading = true;
  wxQr.url = '';
  wxQr.uuid = '';
  wxQr.status = 0;
  wxQr.error = '';
  try {
    const res: any = await createWxLogin();
    if (!isQrSessionActive(sessionVersion, 'wechat')) return;
    if (res?.uuid) {
      wxQr.uuid = res.uuid;
      const base64 = res.qrcode?.qrcodebase64;
      if (base64) {
        wxQr.url = base64.startsWith('data:') ? base64 : `data:image/jpeg;base64,${base64}`;
      } else {
        wxQr.url = res.qrcode?.qrcodeurl || '';
      }
    }
    if (!wxQr.uuid || !wxQr.url) throw new Error('WeChat QR response is incomplete');
    void startCheckWxStatus(sessionVersion);
  } catch (e) {
    if (!isQrSessionActive(sessionVersion, 'wechat')) return;
    logger.error('Login', 'Load Wx QR Error:', e);
    wxQr.error = getApiErrorMessage(e, '微信二维码加载失败，请稍后重试');
    wxQr.status = 3;
  } finally {
    if (sessionVersion === qrSessionVersion) wxQr.isLoading = false;
  }
};

const startCheckWxStatus = async (sessionVersion: number) => {
  if (!wxQr.uuid || !isQrSessionActive(sessionVersion, 'wechat')) return;
  logger.info('Login', 'Starting WeChat polling...');

  while (wxQr.uuid && isQrSessionActive(sessionVersion, 'wechat')) {
    try {
      const res: any = await checkWxLogin(wxQr.uuid, Date.now());
      if (!isQrSessionActive(sessionVersion, 'wechat')) break;
      if (res) {
        const code = res.wx_errcode || res.status;
        if (code === 405) {
          const wxCode = res.wx_code;
          if (wxCode) {
            const loginRes: any = await loginByOpenPlat(wxCode);
            if (!isQrSessionActive(sessionVersion, 'wechat')) break;
            if (loginRes?.status === 1 || loginRes?.code === 200) {
              completeLogin(loginRes.data || loginRes.body?.data || loginRes);
            } else {
              wxQr.error = loginRes?.msg || loginRes?.message || '微信登录失败，请重试';
              wxQr.status = 3;
            }
          } else {
            wxQr.error = '微信授权信息缺失，请重试';
            wxQr.status = 3;
          }
          break;
        } else if (code === 404) {
          wxQr.status = 1;
        } else if (code === 403 || code === 402) {
          wxQr.status = 3;
          break;
        } else if (code === 408) {
          wxQr.status = 0;
        }
      }
    } catch (e) {
      if (!isQrSessionActive(sessionVersion, 'wechat')) break;
      logger.error('Login', 'Check Wx Status Error:', e);
      wxQr.error = getApiErrorMessage(e, '微信登录状态检查失败，请稍后重试');
      wxQr.status = 3;
      break;
    }
    await waitForNextPoll();
  }
  logger.info('Login', 'WeChat polling stopped.');
};

const activateLoginMethod = (method: LoginMethod) => {
  if (isLoginDone) return;
  const sessionVersion = invalidateQrSession();
  logger.info('Login', 'Login method changed to:', method);

  if (method === 'kugou') {
    if (qrKey.value && qrUrl.value && qrStatus.value !== 0) {
      void startCheckStatus(sessionVersion);
    } else {
      void loadQrCode();
    }
  } else if (method === 'qq') {
    if (qqQr.session && qqQr.url && ['waiting', 'scanned'].includes(qqQr.status)) {
      void startCheckQqStatus(sessionVersion);
    } else {
      void loadQqQr();
    }
  } else if (method === 'wechat') {
    if (wxQr.uuid && wxQr.url && wxQr.status !== 3) {
      void startCheckWxStatus(sessionVersion);
    } else {
      void loadWxQr();
    }
  }
};

watch(activeMethod, activateLoginMethod);
watch(
  () => userStore.isLoggedIn,
  (loggedIn) => {
    isLoginDone = loggedIn;
    if (loggedIn) invalidateQrSession();
  },
);

onMounted(() => {
  isLoginDone = userStore.isLoggedIn;
  if (!isLoginDone) activateLoginMethod(activeMethod.value);
});
onUnmounted(() => {
  invalidateQrSession();
  if (smsTimer) clearInterval(smsTimer);
});
</script>

<template>
  <div
    class="login-page fixed inset-0 overflow-hidden bg-bg-main text-text-main transition-colors duration-500 select-none flex flex-col"
  >
    <!-- 装饰背景 -->
    <div
      class="absolute inset-0 bg-linear-to-br from-bg-sidebar via-bg-main to-bg-sidebar opacity-60 z-0"
    ></div>
    <div
      class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-200 h-200 rounded-full bg-primary/3 blur-[120px] pointer-events-none z-0"
    ></div>

    <OverlayHeader />

    <div class="flex-1 relative overflow-hidden flex items-center justify-center p-6 z-10">
      <div class="absolute top-12 left-6 z-100">
        <Button
          @click="closeLoginPage"
          variant="unstyled"
          size="none"
          class="no-drag h-10 w-10 min-w-0 rounded-full p-0 flex items-center justify-center text-text-main dark:text-white bg-[var(--control-hover-bg)] hover:bg-[var(--control-hover-bg)]"
        >
          <Icon :icon="iconChevronLeft" width="24" height="24" />
        </Button>
      </div>

      <!-- 设置 activationMode="manual" 防止焦点自动切换导致意外 Tab 跳转 -->
      <div class="w-full max-w-105 max-h-full flex flex-col items-center">
        <!-- 首次使用提示横幅 -->
        <div
          class="tip-banner mb-4 max-w-full px-4 py-3 rounded-2xl bg-linear-to-r from-amber-500/15 via-amber-400/10 to-amber-500/5 dark:from-amber-400/15 dark:via-amber-400/10 dark:to-amber-300/5 border border-amber-500/25 dark:border-amber-400/25 backdrop-blur-xl inline-flex items-start gap-2.5 shadow-[0_6px_18px_rgba(251,191,36,0.08)]"
        >
          <div
            class="tip-banner-icon mt-0.5 shrink-0 relative w-5 h-5 flex items-center justify-center"
          >
            <span
              class="absolute inset-0 rounded-full bg-amber-500/25 dark:bg-amber-400/30 tip-banner-glow"
            ></span>
            <span
              class="relative w-full h-full rounded-full bg-linear-to-br from-amber-400 to-amber-500 dark:from-amber-300 dark:to-amber-500 text-white flex items-center justify-center shadow-[0_3px_8px_rgba(251,191,36,0.35)]"
            >
              <Icon :icon="iconInfo" width="12" height="12" />
            </span>
          </div>
          <p class="text-[13px] font-bold text-amber-700 dark:text-amber-300 leading-snug">
            首次使用 EchoMusic？请先在手机端下载<span
              class="underline decoration-amber-500/60 dark:decoration-amber-400/60 underline-offset-2"
              >《酷狗概念版》</span
            >，完成账号注册并成功登录后，再返回这里登录。
          </p>
        </div>

        <Tabs v-model="activeMethod" activationMode="manual" class="w-full">
          <div class="login-panel-card">
            <div class="px-10 pt-8 flex-1 flex flex-col items-center justify-center">
              <!-- 1. 扫码登录 -->
              <TabsContent value="kugou" class="w-full animate-fade-in flex flex-col items-center">
                <div class="text-center mb-4">
                  <h1 class="text-[26px] font-black tracking-tight leading-tight mb-1">扫码登录</h1>
                  <p class="text-[13px] opacity-60 font-bold uppercase tracking-[1.5px]">
                    使用酷狗概念版扫码
                  </p>
                </div>
                <div
                  class="relative w-48 h-48 bg-white p-3.5 rounded-[28px] shadow-[0_12px_40px_rgba(0,0,0,0.06)] border border-black/2"
                >
                  <Image :src="qrUrl" class="w-full h-full rounded-xl" />
                  <div
                    v-if="isLoadingQr"
                    class="absolute inset-0 bg-white rounded-2xl flex items-center justify-center z-30"
                  >
                    <Icon
                      :icon="iconRefreshCw"
                      width="24"
                      height="24"
                      class="animate-spin text-primary"
                    />
                  </div>
                  <div
                    v-if="qrStatus === 0"
                    class="absolute inset-0 bg-white/95 rounded-2xl flex flex-col items-center justify-center space-y-4 z-30"
                  >
                    <span class="text-[13px] font-black opacity-60">{{
                      qrError || '二维码已过期'
                    }}</span>
                    <Button
                      @click="loadQrCode"
                      variant="ghost"
                      size="xs"
                      class="text-[13px] text-primary font-black hover:opacity-80"
                      >重新加载</Button
                    >
                  </div>
                  <div
                    v-if="qrStatus === 2"
                    class="absolute inset-0 bg-white/98 rounded-2xl flex flex-col items-center justify-center space-y-5 z-30"
                  >
                    <div
                      class="w-14 h-14 bg-green-500 rounded-full flex items-center justify-center text-white"
                    >
                      <Icon :icon="iconCheck" width="32" height="32" />
                    </div>
                    <p class="text-[14px] font-black opacity-80">请在手机端确认</p>
                  </div>
                </div>
                <div class="mt-6 w-full relative flex items-center justify-center">
                  <span class="text-[11px] font-black opacity-40 uppercase tracking-[3px]">
                    {{
                      isLoadingQr
                        ? '正在生成二维码'
                        : qrStatus === 2
                          ? '已扫码，等待确认'
                          : '等待酷狗扫码'
                    }}
                  </span>
                  <button
                    class="absolute right-0 w-7 h-7 rounded-full flex items-center justify-center text-text-main/40 hover:text-primary hover:bg-primary/10 transition-all active:scale-90"
                    :disabled="isLoadingQr"
                    @click="loadQrCode"
                  >
                    <Icon :icon="iconRefreshCw" width="14" height="14" />
                  </button>
                </div>
              </TabsContent>

              <!-- 2. 验证码登录 -->
              <TabsContent value="sms" class="w-full animate-fade-in pb-2">
                <div class="text-center mb-4">
                  <h1 class="text-[26px] font-black mb-1">验证码登录</h1>
                  <p class="text-[13px] opacity-60 font-bold uppercase tracking-[1.5px]">
                    无需密码，快捷安全
                  </p>
                </div>
                <div v-if="smsData.accountCandidates.length === 0" class="flex flex-col">
                  <Input v-model="smsData.mobile" type="tel" placeholder="手机号码" class="mb-4" />
                  <div class="flex gap-3 mb-1">
                    <Input
                      v-model="smsData.code"
                      placeholder="验证码"
                      class="flex-1"
                      inputClass="pr-10"
                    />
                    <Button
                      variant="secondary"
                      class="shrink-0 whitespace-nowrap"
                      :disabled="smsData.countdown > 0"
                      @click="handleSendCode"
                    >
                      {{ smsData.countdown > 0 ? `${smsData.countdown}s` : '获取验证码' }}
                    </Button>
                  </div>
                  <div class="h-5 flex items-center px-2 mb-1">
                    <p v-if="smsData.error" class="text-[11px] text-red-500 font-bold">
                      {{ smsData.error }}
                    </p>
                  </div>
                  <Button class="w-full" :loading="smsData.isSending" @click="handleSmsLogin">
                    立即登录
                  </Button>
                </div>
                <div v-else class="flex flex-col">
                  <div class="mb-3 flex items-center justify-between px-1">
                    <span class="text-[13px] font-black">选择账号</span>
                    <button
                      class="text-[12px] font-bold text-text-secondary hover:text-primary transition-colors"
                      :disabled="smsData.isSending"
                      @click="resetSmsAccountCandidates"
                    >
                      返回
                    </button>
                  </div>
                  <div class="space-y-2 mb-3 max-h-48 overflow-y-auto pr-1">
                    <button
                      v-for="account in smsData.accountCandidates"
                      :key="account.userid"
                      class="w-full h-16 rounded-xl border border-[var(--control-border)] bg-[var(--control-bg)] hover:bg-[var(--control-hover-bg)] hover:border-primary/40 transition-all px-3 flex items-center gap-3 text-left disabled:opacity-70"
                      :disabled="smsData.isSending"
                      @click="handleSmsAccountLogin(account)"
                    >
                      <Avatar
                        :src="account.pic"
                        :alt="account.nickname"
                        class="w-11 h-11 rounded-full"
                      />
                      <div class="min-w-0 flex-1">
                        <div class="text-[13px] font-black truncate">{{ account.nickname }}</div>
                        <div class="text-[11px] font-bold text-text-secondary truncate">
                          {{ account.username || account.userid }}
                        </div>
                      </div>
                      <span
                        v-if="smsData.pendingUserid === account.userid"
                        class="text-[11px] font-black text-primary"
                      >
                        登录中
                      </span>
                    </button>
                  </div>
                  <div class="h-5 flex items-center px-2 mb-1">
                    <p v-if="smsData.error" class="text-[11px] text-red-500 font-bold">
                      {{ smsData.error }}
                    </p>
                  </div>
                </div>
              </TabsContent>

              <!-- 3. 账号登录 -->
              <TabsContent value="account" class="w-full animate-fade-in pb-2">
                <div class="text-center mb-4">
                  <h1 class="text-[26px] font-black mb-1">账号登录</h1>
                  <p class="text-[13px] opacity-60 font-bold uppercase tracking-[1.5px]">
                    可能需要安全验证
                  </p>
                </div>
                <div class="flex flex-col">
                  <Input
                    v-model="accountData.username"
                    type="text"
                    placeholder="用户名"
                    class="mb-4"
                    @keyup.enter="handleAccountLogin"
                  />
                  <Input
                    v-model="accountData.password"
                    type="password"
                    placeholder="密码"
                    class="mb-1"
                    @keyup.enter="handleAccountLogin"
                  />
                  <div class="h-5 flex items-center px-2 mb-1">
                    <p v-if="accountData.error" class="text-[11px] text-red-500 font-bold">
                      {{ accountData.error }}
                    </p>
                  </div>
                  <Button
                    class="w-full"
                    :loading="accountData.isSubmitting"
                    :disabled="!accountData.username.trim() || !accountData.password.trim()"
                    @click="handleAccountLogin"
                  >
                    立即登录
                  </Button>
                </div>
              </TabsContent>

              <!-- 4. QQ 扫码 -->
              <TabsContent value="qq" class="w-full animate-fade-in flex flex-col items-center">
                <div class="text-center mb-4">
                  <h1 class="text-[26px] font-black mb-1">QQ 登录</h1>
                  <p class="text-[13px] opacity-60 font-bold uppercase tracking-[1.5px]">
                    请使用 QQ 扫描二维码
                  </p>
                </div>
                <div
                  class="relative w-48 h-48 bg-white p-3.5 rounded-[28px] shadow-[0_12px_40px_rgba(0,0,0,0.06)] border border-black/2"
                >
                  <Image :src="qqQr.url" class="w-full h-full rounded-xl" />
                  <div
                    v-if="qqQr.isLoading"
                    class="absolute inset-0 bg-white rounded-2xl flex items-center justify-center z-30"
                  >
                    <Icon
                      :icon="iconRefreshCw"
                      width="24"
                      height="24"
                      class="animate-spin text-[#12B7F5]"
                    />
                  </div>
                  <div
                    v-else-if="qqQr.status === 'expired' || qqQr.status === 'error'"
                    class="absolute inset-0 bg-white/95 rounded-2xl flex flex-col items-center justify-center space-y-4 z-30 px-5 text-center"
                  >
                    <span class="text-[13px] font-black text-black/60">
                      {{ qqQr.error || qqQr.message || '二维码已过期' }}
                    </span>
                    <Button
                      @click="loadQqQr"
                      variant="ghost"
                      size="xs"
                      class="text-[13px] text-[#12B7F5] font-black hover:opacity-80"
                      >重新加载</Button
                    >
                  </div>
                  <div
                    v-else-if="qqQr.status === 'scanned'"
                    class="absolute inset-0 bg-white/98 rounded-2xl flex flex-col items-center justify-center space-y-5 z-30"
                  >
                    <div
                      class="w-14 h-14 bg-[#12B7F5] rounded-full flex items-center justify-center text-white"
                    >
                      <Icon :icon="iconCheck" width="32" height="32" />
                    </div>
                    <p class="text-[14px] font-black text-black/80">请在 QQ 中确认</p>
                  </div>
                </div>
                <div class="mt-6 w-full relative flex items-center justify-center">
                  <span class="text-[11px] font-black opacity-40 uppercase tracking-[3px]">
                    {{ qqQr.isLoading ? '正在生成二维码' : qqQr.message || '等待 QQ 扫码' }}
                  </span>
                  <button
                    class="absolute right-0 w-7 h-7 rounded-full flex items-center justify-center text-text-main/40 hover:text-[#12B7F5] hover:bg-[#12B7F5]/10 transition-all active:scale-90 disabled:opacity-40"
                    :disabled="qqQr.isLoading"
                    title="刷新 QQ 二维码"
                    aria-label="刷新 QQ 二维码"
                    @click="loadQqQr"
                  >
                    <Icon :icon="iconRefreshCw" width="14" height="14" />
                  </button>
                </div>
              </TabsContent>

              <!-- 5. 微信扫码 -->
              <TabsContent value="wechat" class="w-full animate-fade-in flex flex-col items-center">
                <div class="text-center mb-4">
                  <h1 class="text-[26px] font-black mb-1">微信登录</h1>
                  <p class="text-[13px] opacity-60 font-bold uppercase tracking-[1.5px]">
                    请使用微信扫描二维码
                  </p>
                </div>
                <div
                  class="relative w-48 h-48 bg-white p-3.5 rounded-[28px] shadow-[0_12px_40px_rgba(0,0,0,0.06)] border border-black/2"
                >
                  <Image :src="wxQr.url" class="w-full h-full rounded-xl" />
                  <div
                    v-if="wxQr.isLoading"
                    class="absolute inset-0 bg-white rounded-2xl flex items-center justify-center z-30"
                  >
                    <Icon
                      :icon="iconRefreshCw"
                      width="24"
                      height="24"
                      class="animate-spin text-[#07C160]"
                    />
                  </div>
                  <div
                    v-else-if="wxQr.status === 3"
                    class="absolute inset-0 bg-white/95 rounded-2xl flex flex-col items-center justify-center space-y-4 z-30"
                  >
                    <span class="text-[13px] font-black opacity-60">{{
                      wxQr.error || '二维码已过期'
                    }}</span>
                    <Button
                      @click="loadWxQr"
                      variant="ghost"
                      size="xs"
                      class="text-[13px] text-[#07C160] font-black hover:opacity-80"
                      >重新加载</Button
                    >
                  </div>
                  <div
                    v-if="wxQr.status === 1"
                    class="absolute inset-0 bg-white/98 rounded-2xl flex flex-col items-center justify-center space-y-5 z-30"
                  >
                    <div
                      class="w-14 h-14 bg-[#07C160] rounded-full flex items-center justify-center text-white"
                    >
                      <Icon :icon="iconCheck" width="32" height="32" />
                    </div>
                    <p class="text-[14px] font-black opacity-80">请在手机端确认</p>
                  </div>
                </div>
                <div class="mt-6 w-full relative flex items-center justify-center">
                  <span class="text-[11px] font-black opacity-40 uppercase tracking-[3px]">
                    {{
                      wxQr.isLoading
                        ? '正在生成二维码'
                        : wxQr.status === 1
                          ? '已扫码，等待确认'
                          : '等待微信扫码'
                    }}
                  </span>
                  <button
                    class="absolute right-0 w-7 h-7 rounded-full flex items-center justify-center text-text-main/40 hover:text-[#07C160] hover:bg-[#07C160]/10 transition-all active:scale-90"
                    :disabled="wxQr.isLoading"
                    @click="loadWxQr"
                  >
                    <Icon :icon="iconRefreshCw" width="14" height="14" />
                  </button>
                </div>
              </TabsContent>
            </div>

            <!-- 底部：登录方式选择 -->
            <div class="px-8 pb-7">
              <div
                class="pt-5 border-t border-[var(--border-subtle)] flex flex-col items-center space-y-3"
              >
                <span class="text-[11px] font-black opacity-45 uppercase tracking-[3px]"
                  >选择登录方式</span
                >
                <TabsList
                  class="login-method-list grid! grid-cols-5 gap-2 h-auto! w-full items-stretch"
                >
                  <TabsTrigger
                    v-for="method in loginMethods"
                    :key="method.value"
                    :value="method.value"
                    :data-tone="method.tone"
                    :title="`${method.label}登录`"
                    :aria-label="`${method.label}登录`"
                    class="login-method-trigger group h-14! pb-0! flex-col! items-center! justify-center! gap-1 rounded-2xl border border-transparent opacity-65! hover:opacity-100! data-[state=active]:opacity-100! [&_.active-line]:hidden"
                  >
                    <Icon :icon="method.icon" width="20" height="20" />
                    <span class="text-[10px] leading-none font-black">{{ method.label }}</span>
                  </TabsTrigger>
                </TabsList>
              </div>
            </div>
          </div>
        </Tabs>
      </div>
    </div>
  </div>
</template>

<style scoped>
.login-panel-card {
  display: flex;
  flex-direction: column;
  height: 31.875rem;
  overflow: hidden;
  border-radius: 36px;
  background: var(--color-bg-dialog);
  border: 1px solid var(--border-subtle);
  box-shadow: var(--shadow-dialog);
  -webkit-backdrop-filter: var(--surface-backdrop-filter);
  backdrop-filter: var(--surface-backdrop-filter);
  transition: all 0.5s ease;
}

.animate-fade-in {
  animation: fade-in 0.6s cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
}

:deep(.login-method-trigger) {
  color: var(--color-text-secondary);
  transition:
    color 180ms ease,
    background-color 180ms ease,
    border-color 180ms ease,
    transform 180ms ease;
}

:deep(.login-method-trigger:hover) {
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 7%, transparent);
}

:deep(.login-method-trigger[data-state='active']) {
  color: var(--color-primary);
  border-color: color-mix(in srgb, var(--color-primary) 28%, transparent);
  background: color-mix(in srgb, var(--color-primary) 11%, transparent);
  transform: translateY(-1px);
}

:deep(.login-method-trigger[data-tone='qq'][data-state='active']) {
  color: #12b7f5;
  border-color: rgb(18 183 245 / 28%);
  background: rgb(18 183 245 / 10%);
}

:deep(.login-method-trigger[data-tone='wechat'][data-state='active']) {
  color: #07c160;
  border-color: rgb(7 193 96 / 28%);
  background: rgb(7 193 96 / 10%);
}

@keyframes fade-in {
  from {
    opacity: 0;
    transform: translateY(30px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* 首次使用提示横幅进场动效 */
.tip-banner {
  animation: tip-banner-in 0.7s cubic-bezier(0.2, 0.8, 0.2, 1) both;
}
@keyframes tip-banner-in {
  from {
    opacity: 0;
    transform: translateY(-12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* 图标柔和呼吸光晕 */
.tip-banner-glow {
  animation: tip-banner-pulse 2.6s ease-in-out infinite;
}
@keyframes tip-banner-pulse {
  0%,
  100% {
    transform: scale(1);
    opacity: 0.55;
  }
  50% {
    transform: scale(1.35);
    opacity: 0;
  }
}
</style>
