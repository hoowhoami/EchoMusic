import { reactive } from 'vue';
import logger from '@/utils/logger';

type VerifyAssetName = 'verifycode.js' | 'verifycode_bg.wasm' | 'verifycode_bg_ios.wasm';

type VerifyApiRequest = (url: string, params: Record<string, string | number>) => Promise<any>;

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
let verifyRuntimePromise: Promise<any> | null = null;

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

const toArrayBuffer = (value: ArrayBuffer | ArrayBufferView): ArrayBuffer => {
  if (value instanceof ArrayBuffer) return value;
  const buffer = new ArrayBuffer(value.byteLength);
  new Uint8Array(buffer).set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  return buffer;
};

const readVerifyAsset = async (name: VerifyAssetName): Promise<ArrayBuffer> => {
  const asset = await window.electron?.apiServer?.readVerifyAsset?.(name);
  if (!asset) {
    throw new Error('安全验证资源不可用');
  }
  return toArrayBuffer(asset);
};

const loadScriptFromServerAsset = async () => {
  if (typeof window === 'undefined') return;
  if ((window as any).wasm_bindgen?.EData) return;

  const scriptBytes = await readVerifyAsset('verifycode.js');
  const scriptText = new TextDecoder('utf-8').decode(scriptBytes);
  const blobUrl = URL.createObjectURL(new Blob([scriptText], { type: 'text/javascript' }));

  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = blobUrl;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('安全验证脚本加载失败'));
    document.head.appendChild(script);
  });
  URL.revokeObjectURL(blobUrl);
};

const ensureVerifyRuntime = async () => {
  if (!verifyRuntimePromise) {
    verifyRuntimePromise = (async () => {
      await loadScriptFromServerAsset();
      const wasmBindgen = (window as any).wasm_bindgen;
      if (!wasmBindgen?.EData) {
        throw new Error('安全验证运行时初始化失败');
      }

      const wasmBytes = await readVerifyAsset('verifycode_bg_ios.wasm');
      await wasmBindgen(wasmBytes);
      wasmBindgen.run?.();
      return wasmBindgen;
    })().catch((error) => {
      verifyRuntimePromise = null;
      throw error;
    });
  }

  return verifyRuntimePromise;
};

const createVerifyPayload = async () => {
  const wasmBindgen = await ensureVerifyRuntime();
  const eData = new wasmBindgen.EData();
  try {
    return {
      sid: eData.get_sid(),
      edt: eData.get_edt(),
    };
  } finally {
    eData.free?.();
  }
};

const resetState = () => {
  kugouVerificationState.open = false;
  kugouVerificationState.eventId = '';
  kugouVerificationState.verifyInfo = null;
  kugouVerificationState.status = 'idle';
  kugouVerificationState.error = '';
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
    const body = await activeChallenge.request('/get/verify/info', {
      eventid: activeChallenge.eventId,
    });
    kugouVerificationState.verifyInfo = body?.data ?? body;
    kugouVerificationState.status = 'ready';
  } catch (error) {
    logger.error('KugouVerification', 'Failed to load verify info', error);
    kugouVerificationState.status = 'error';
    kugouVerificationState.error = '安全验证信息获取失败，请稍后重试';
  }
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

export const requestKugouVerification = (eventId: string, request: VerifyApiRequest) => {
  const normalizedEventId = String(eventId || '').trim();
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

export const submitKugouVerification = async (verifyCode: string) => {
  if (!activeChallenge) {
    throw new Error('当前没有待处理的安全验证');
  }

  const code = String(verifyCode || '').trim();
  if (!code) {
    kugouVerificationState.error = '请输入验证码';
    return;
  }

  const verifyInfo = kugouVerificationState.verifyInfo;
  const verifyType = Number(verifyInfo?.v_type || 23);
  kugouVerificationState.status = 'verifying';
  kugouVerificationState.error = '';

  try {
    const payload = await createVerifyPayload();
    await activeChallenge.request('/verify/user/info', {
      eventid: activeChallenge.eventId,
      v_type: verifyType,
      verifycode: encodeURIComponent(code),
      sid: encodeURIComponent(payload.sid),
      edt: encodeURIComponent(payload.edt),
    });
    kugouVerificationState.status = 'success';
    finishActiveChallenge();
  } catch (error) {
    logger.error('KugouVerification', 'Verify user info failed', error);
    kugouVerificationState.status = 'error';
    kugouVerificationState.error = '验证失败，请重试';
  }
};

export const cancelKugouVerification = () => {
  finishActiveChallenge(new Error('已取消安全验证'));
};
