import request from '@/utils/request';

/**
 * 注册设备获取 dfid/mid
 */
export function registerDevice() {
  return request.get('/register/dev', {
    headers: {
      'X-Skip-Auth': '1',
    },
  });
}

/**
 * 获取二维码 Key (酷狗扫码)
 */
export function getLoginQrKey() {
  return request.get('/login/qr/key');
}

/**
 * 创建二维码 (酷狗扫码)
 */
export function createLoginQr(key: string) {
  return request.get('/login/qr/create', {
    params: { key, qrimg: 'true' },
  });
}

/**
 * 检查二维码状态 (酷狗扫码)
 */
export function checkLoginQr(key: string) {
  return request.get('/login/qr/check', {
    params: { key },
  });
}

/**
 * 发送手机验证码
 */
export function sendSmsCode(mobile: string) {
  return request.get('/captcha/sent', {
    params: { mobile },
  });
}

/**
 * 手机验证码登录
 */
export function loginBySms(mobile: string, code: string, userid?: string | number) {
  return request.get('/login/cellphone', {
    params: {
      mobile,
      code,
      ...(userid ? { userid } : {}),
    },
  });
}

/**
 * 用户名/密码登录
 */
export function loginByPassword(username: string, password: string) {
  return request.get('/login', {
    params: { username, password },
  });
}

/**
 * 创建微信登录二维码
 */
export function createWxLogin() {
  return request.get('/login/wx/create');
}

/**
 * 检查微信登录状态
 */
export function checkWxLogin(uuid: string, timestamp?: number) {
  return request.get('/login/wx/check', {
    params: { uuid, timestamp },
  });
}

/**
 * 开放平台登录 (微信登录最终步骤)
 */
export function loginByOpenPlat(code: string) {
  return request.get('/login/openplat', {
    params: { code, plat: 2 },
  });
}

/**
 * 获取用户信息
 */
export function getUserDetail() {
  return request.get('/user/detail');
}

/**
 * 获取用户 VIP 信息
 */
export function getUserVipDetail() {
  return request.get('/user/vip/detail');
}

/**
 * 领取每日畅听会员
 */
export function claimDayVip(day: string) {
  return request.get('/youth/day/vip', {
    params: { receive_day: day },
  });
}

/**
 * 升级每日概念会员
 */
export function upgradeDayVip() {
  return request.get('/youth/day/vip/upgrade');
}

/**
 * 获取 VIP 领取记录
 */
export function getVipMonthRecord() {
  return request.get('/youth/month/vip/record');
}

/**
 * 获取播放历史
 */
export function getUserHistory(bp?: string) {
  return request.get('/user/history', {
    params: { bp },
  });
}

/**
 * 获取服务器时间
 */
export function getServerNow() {
  return request.get('/server/now');
}

/**
 * 上传播放历史
 * @param mixSongId 歌曲 mixSongId
 */
export function uploadPlayHistory(mxid: number | string) {
  return request.get('/playhistory/upload', {
    params: {
      mxid,
    },
  });
}

/**
 * 上报听歌时长（用于等级积分）
 */
export function reportListenTime() {
  return request.get('/listen/timeadd');
}

/**
 * 获取用户云盘
 */
export function getUserCloud(page = 1, pagesize = 30) {
  return request.get('/user/cloud', {
    params: { page, pagesize },
  });
}

/**
 * 上传音乐文件到用户云盘（二进制 body，支持分片上传与秒传）
 * @param data 文件二进制内容（Uint8Array / ArrayBuffer）
 * @param options 文件信息
 */
export async function uploadToCloud(
  data: Uint8Array | ArrayBuffer,
  options: {
    name: string;
    extendname?: string;
    authorName?: string;
    audioId?: string | number;
    albumAudioId?: string | number;
  },
) {
  const extendname = options.extendname || options.name.split('.').pop()?.toLowerCase() || 'mp3';
  const baseName = options.name.replace(/\.[^.]+$/, '');
  try {
    const res = await request.post('/user/cloud/upload', data, {
      params: {
        extendname,
        name: baseName,
        ...(options.authorName ? { author_name: options.authorName } : {}),
        ...(options.audioId ? { audio_id: options.audioId } : {}),
        ...(options.albumAudioId ? { album_audio_id: options.albumAudioId } : {}),
      },
    });
    // 上游可能返回 HTTP 200 但业务失败（error_code 非 0 / status 非 1），需主动抛错
    const body = res as { error_code?: number | string; status?: number; msg?: string } | null;
    const errorCode = Number(body?.error_code ?? 0);
    if (body && (errorCode !== 0 || Number(body.status ?? 1) !== 1)) {
      const err = new Error(body?.msg || `上传失败（error_code=${errorCode}）`);
      (err as any).response = res;
      throw err;
    }
    return res;
  } catch (error: any) {
    // 后端业务失败时 status=500 且 body 携带 msg，转换为可读错误
    const msg = error?.response?.body?.msg;
    if (msg) {
      const err = new Error(String(msg));
      (err as any).response = error?.response;
      throw err;
    }
    throw error;
  }
}

/**
 * 获取用户关注歌手
 */
export function getUserFollow() {
  return request.get('/user/follow');
}

/**
 * 获取用户收藏的视频
 */
export function getUserVideoCollect(page = 1, pagesize = 30) {
  return request.get('/user/video/collect', {
    params: { page, pagesize },
  });
}
