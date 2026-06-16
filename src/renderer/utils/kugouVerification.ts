import { reactive } from 'vue';
import logger from '@/utils/logger';

type VerifyApiRequest = (url: string, params: Record<string, string | number>) => Promise<any>;

export interface KugouVerificationChallenge {
  eventId: string;
}

export interface KugouVerificationInfo {
  v_type?: number | string;
  txappid?: string;
  business?: string;
  sessionid?: string;
  url?: string;
}

export type KugouCaptchaProvider = 'TX' | 'GT' | 'KG' | 'KG2' | 'SM' | 'YD' | 'SMS' | 'UNKNOWN';

export const KUGOU_CAPTCHA_PROVIDER_NAMES: Record<KugouCaptchaProvider, string> = {
  TX: '腾讯验证码',
  GT: '极验验证码',
  KG: '酷狗滑块',
  KG2: '酷狗旋转',
  SM: '数美验证码',
  YD: '网易易盾',
  SMS: '手机验证码',
  UNKNOWN: '未知验证',
};

interface PendingChallenge {
  eventId: string;
  request: VerifyApiRequest;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface LoadVerifyInfoOptions {
  readyError?: string;
}

export const kugouVerificationState = reactive({
  open: false,
  eventId: '',
  verifyInfo: null as KugouVerificationInfo | null,
  status: 'idle' as 'idle' | 'loading' | 'ready' | 'verifying' | 'success' | 'error',
  error: '',
});

let activeChallenge: PendingChallenge | null = null;
const challengeQueue: PendingChallenge[] = [];
const challengePromises = new Map<string, Promise<void>>();

export const getKugouCaptchaProvider = (
  verifyInfo: KugouVerificationInfo | null | undefined,
): KugouCaptchaProvider => {
  const verifyType = Number(verifyInfo?.v_type || 0);
  if (verifyType === 32) return 'SMS';

  const url = String(verifyInfo?.url || '').trim();
  const match = url.match(/^KGCode([A-Z0-9]+)\|/i);
  if (!match) {
    return verifyInfo?.txappid ? 'TX' : 'UNKNOWN';
  }

  const provider = match[1].toUpperCase();
  if (provider === 'TX') return 'TX';
  if (provider === 'GT') return 'GT';
  if (provider === 'KG') return 'KG';
  if (provider === 'KG2') return 'KG2';
  if (provider === 'SM') return 'SM';
  if (provider === 'YD') return 'YD';
  return 'UNKNOWN';
};

const resetState = () => {
  kugouVerificationState.open = false;
  kugouVerificationState.eventId = '';
  kugouVerificationState.verifyInfo = null;
  kugouVerificationState.status = 'idle';
  kugouVerificationState.error = '';
};

const loadVerifyInfoForChallenge = async (
  challenge: PendingChallenge,
  options: LoadVerifyInfoOptions = {},
) => {
  kugouVerificationState.status = 'loading';
  kugouVerificationState.error = '';

  const body = await challenge.request('/get/verify/info', {
    eventid: challenge.eventId,
  });

  if (activeChallenge !== challenge) return;

  kugouVerificationState.verifyInfo = body?.data ?? body;
  kugouVerificationState.status = 'ready';
  kugouVerificationState.error = options.readyError ?? '';
};

const startNextChallenge = async () => {
  if (activeChallenge || challengeQueue.length === 0) return;

  activeChallenge = challengeQueue.shift() ?? null;
  if (!activeChallenge) return;

  kugouVerificationState.open = true;
  kugouVerificationState.eventId = activeChallenge.eventId;
  kugouVerificationState.verifyInfo = null;
  kugouVerificationState.status = 'loading';
  kugouVerificationState.error = '';

  try {
    await loadVerifyInfoForChallenge(activeChallenge);
  } catch (error) {
    logger.error('KugouVerification', 'Failed to load verify info', error);
    if (activeChallenge) {
      kugouVerificationState.status = 'error';
      kugouVerificationState.error = '安全验证信息获取失败，请稍后重试';
    }
  }
};

const getVerifyFailureMessage = (error: unknown) => {
  const response = (error as any)?.response;
  const body = response?.body;
  const errorCode = Number(body?.error_code ?? body?.errorCode ?? 0);
  const dataMessage = typeof body?.data === 'string' ? body.data : '';
  const msgMessage = typeof body?.msg === 'string' ? body.msg : '';
  const message = dataMessage || msgMessage;

  if (errorCode === 30791 || message.includes('验证不通过')) {
    return '验证未通过，请重新完成图形验证';
  }

  return '验证失败，请重新验证';
};

const finishActiveChallenge = (error?: Error) => {
  const challenge = activeChallenge;
  activeChallenge = null;
  resetState();

  if (challenge) {
    if (error) challenge.reject(error);
    else challenge.resolve();
  }

  void startNextChallenge();
};

const normalizeChallenge = (
  challenge: string | KugouVerificationChallenge,
): KugouVerificationChallenge => {
  if (typeof challenge === 'string') {
    return { eventId: challenge };
  }
  return challenge;
};

export const requestKugouVerification = (
  challenge: string | KugouVerificationChallenge,
  request: VerifyApiRequest,
) => {
  const challengeInfo = normalizeChallenge(challenge);
  const normalizedEventId = String(challengeInfo.eventId || '').trim();
  if (!normalizedEventId) {
    return Promise.reject(new Error('缺少安全验证事件标识'));
  }

  const existingPromise = challengePromises.get(normalizedEventId);
  if (existingPromise) return existingPromise;

  const promise = new Promise<void>((resolve, reject) => {
    challengeQueue.push({
      eventId: normalizedEventId,
      request,
      resolve,
      reject,
    });
    void startNextChallenge();
  });

  challengePromises.set(normalizedEventId, promise);
  void promise.then(
    () => challengePromises.delete(normalizedEventId),
    () => challengePromises.delete(normalizedEventId),
  );

  return promise;
};

export const submitKugouVerification = async (verifyCode: string): Promise<boolean> => {
  const challenge = activeChallenge;
  if (!challenge) {
    throw new Error('当前没有待处理的安全验证');
  }

  const code = String(verifyCode || '').trim();
  if (!code) {
    kugouVerificationState.error = '请输入验证码';
    return false;
  }

  const verifyInfo = kugouVerificationState.verifyInfo;
  const verifyType = Number(verifyInfo?.v_type || 23);
  kugouVerificationState.status = 'verifying';
  kugouVerificationState.error = '';

  try {
    // 桌面端无法在浏览器侧采集行为指纹，统一交由服务端 /sidedt 模拟生成 sid/edt 并完成校验。
    await challenge.request('/sidedt', {
      eventid: challenge.eventId,
      v_type: verifyType,
      verifycode: code,
    });
    if (activeChallenge !== challenge) return false;
    kugouVerificationState.status = 'success';
    finishActiveChallenge();
    return true;
  } catch (error) {
    logger.error('KugouVerification', 'Verify user info failed', error);
    if (activeChallenge !== challenge) return false;
    const readyError = getVerifyFailureMessage(error);
    kugouVerificationState.status = 'error';
    kugouVerificationState.error = readyError;
    finishActiveChallenge(new Error(readyError));
    return false;
  }
};

export const refreshKugouVerificationInfo = async (readyError = '') => {
  const challenge = activeChallenge;
  if (!challenge) {
    throw new Error('当前没有待处理的安全验证');
  }

  try {
    await loadVerifyInfoForChallenge(challenge, { readyError });
  } catch (error) {
    logger.error('KugouVerification', 'Failed to refresh verify info', error);
    if (activeChallenge === challenge) {
      kugouVerificationState.status = 'error';
      kugouVerificationState.error = '验证信息刷新失败，请重新触发操作';
    }
    throw error;
  }
};

export const cancelKugouVerification = () => {
  finishActiveChallenge(new Error('已取消安全验证'));
};
