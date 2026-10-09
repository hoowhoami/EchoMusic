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
  return request.get('/login/qr/key', { skipUserAuth: true });
}

/**
 * 创建二维码 (酷狗扫码)
 */
export function createLoginQr(key: string) {
  return request.get('/login/qr/create', {
    skipUserAuth: true,
    params: { key, qrimg: 'true' },
  });
}

/**
 * 检查二维码状态 (酷狗扫码)
 */
export function checkLoginQr(key: string) {
  return request.get('/login/qr/check', {
    skipUserAuth: true,
    params: { key },
  });
}

export interface QqLoginQrSession {
  cookie: string;
  qrsig: string;
  ptqrtoken: string | number;
  pt_login_sig: string;
  pt_openlogin_data: string;
  xlogin_url: string;
}

/**
 * 创建 QQ 登录二维码及轮询会话
 */
export function createQqLoginQr() {
  return request.get('/login/qq/qr/create', { skipUserAuth: true });
}

/**
 * 检查 QQ 扫码状态，成功后直接返回酷狗登录态
 */
export function checkQqLoginQr(session: QqLoginQrSession) {
  return request.get('/login/qq/qr/check', {
    skipUserAuth: true,
    params: {
      ...session,
      timestamp: Date.now(),
    },
  });
}

/**
 * 发送手机验证码
 */
export function sendSmsCode(mobile: string) {
  return request.get('/captcha/sent', {
    skipUserAuth: true,
    params: { mobile },
  });
}

/**
 * 手机验证码登录
 */
export function loginBySms(mobile: string, code: string, userid?: string | number) {
  return request.get('/login/cellphone', {
    skipUserAuth: true,
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
    skipUserAuth: true,
    params: { username, password },
  });
}

/**
 * 创建微信登录二维码
 */
export function createWxLogin() {
  return request.get('/login/wx/create', { skipUserAuth: true });
}

/**
 * 检查微信登录状态
 */
export function checkWxLogin(uuid: string, timestamp?: number) {
  return request.get('/login/wx/check', {
    skipUserAuth: true,
    params: { uuid, timestamp },
  });
}

/**
 * 开放平台登录 (微信登录最终步骤)
 */
export function loginByOpenPlat(code: string) {
  return request.get('/login/openplat', {
    skipUserAuth: true,
    params: { code, plat: 2 },
  });
}

/**
 * 获取用户信息
 */
export function getUserDetail() {
  return request.get('/user/detail');
}

/** 学生身份与个人资料标签。 */
export function getUserInfo() {
  return request.get('/user/info');
}

/** 获取歌曲 Auth 接口所需的用户授权，IPC 调用方需显式传递返回的 auth。 */
export function getUserVerify() {
  return request.get('/user/verify');
}

export interface UpdateUserProfileParams {
  nickname?: string;
  sex?: 0 | 1 | 2;
  birthday?: string;
  signature?: string;
  province?: string;
  city?: string;
  memo?: string;
  tags?: string;
}

interface UserMutationResponse {
  status?: number | string;
  error_code?: number | string;
  errcode?: number | string;
  msg?: string;
  data?: unknown;
  photo?: string;
  pic?: string;
  reviewPending?: boolean;
  [key: string]: unknown;
}

const getMutationErrorBody = (error: unknown): UserMutationResponse | undefined => {
  const response = (error as { response?: unknown } | null)?.response;
  if (!response || typeof response !== 'object') return undefined;
  const body = (response as { body?: unknown }).body;
  return body && typeof body === 'object'
    ? (body as UserMutationResponse)
    : (response as UserMutationResponse);
};

const ensureUserMutationSucceeded = (payload: unknown, fallback: string): UserMutationResponse => {
  const body =
    payload && typeof payload === 'object' ? (payload as UserMutationResponse) : undefined;
  const status = Number(body?.status ?? 1);
  const errorCode = Number(body?.error_code ?? body?.errcode ?? 0);
  if (!body || status === 0 || errorCode !== 0) {
    const error = new Error(body?.msg || fallback);
    (error as Error & { response?: unknown }).response = payload;
    throw error;
  }
  return body;
};

/**
 * 修改当前登录账号的个人资料。
 */
export async function updateUserProfile(params: UpdateUserProfileParams) {
  const response = await request.post('/user/update', params);
  return ensureUserMutationSucceeded(response, '个人资料保存失败');
}

/**
 * 上传并修改当前登录账号的头像。
 * imgFile 使用 dataURL，内置 server 会完成图床 multipart 上传与资料写入。
 */
export async function updateUserAvatar(imgFile: string, filename?: string) {
  try {
    const response = await request.post('/user/update/avatar', {
      imgFile,
      ...(filename ? { filename } : {}),
    });
    return ensureUserMutationSucceeded(response, '头像上传失败');
  } catch (error) {
    const body = getMutationErrorBody(error);
    // 图床上传完成后，账号资料接口会用 34236 表示头像已进入审核队列。
    // 这是可接受的提交终态，不应向用户提示上传失败。
    if (Number(body?.error_code ?? body?.errcode ?? 0) === 34236) {
      return { ...body, reviewPending: true };
    }
    throw error;
  }
}

export interface LoginDeviceKickTarget {
  t_mid?: string | number;
  t?: string | number;
  t_appid?: string | number;
  t_clientver?: string | number;
  mid?: string | number;
  dfid?: string | number;
  uuid?: string | number;
}

/**
 * 获取当前账号登录设备列表
 */
export function getLoginDevices() {
  return request.get('/login/device');
}

/**
 * 移除指定登录设备
 */
export function kickLoginDevice(target: LoginDeviceKickTarget) {
  return request.get('/login/device/kick', {
    params: {
      ...target,
    },
  });
}

/**
 * 获取用户 VIP 信息
 */
export function getUserVipDetail() {
  return request.get('/user/vip/detail');
}

/** 概念版音质权益；vip_type=6 为豪华VIP，user_type & 16 表示超级VIP。 */
export function getYouthUnionVip() {
  return request.get('/youth/union/vip');
}

/**
 * 批量查询评论作者概念/畅听等产品（Young `/v2/batch_union_vipinfo`）
 */
export function getBatchUnionVipinfo(useridlist: Array<string | number>) {
  return request.get('/user/batch/union/vipinfo', {
    params: { useridlist: useridlist?.join(',') },
    headers: {
      'X-Skip-Auth': '1',
    },
  });
}

/**
 * 获取当前账号好友列表。
 */
export function getUserFriends() {
  return request.post('/user/friends');
}

/**
 * 获取当前账号粉丝列表。
 */
export function getUserFans() {
  return request.post('/user/fans');
}

export interface UserFollowParams {
  tuid: string | number;
  source?: number;
}

/** 关注酷狗用户，与歌手关注体系独立。 */
export function addUserFollow(params: UserFollowParams) {
  return request.post('/user/follow/add', params);
}

/** 取消关注酷狗用户。 */
export function deleteUserFollow(params: UserFollowParams) {
  return request.post('/user/follow/del', params);
}

/**
 * 获取访客列表，默认查当前账号。
 */
export function getUserVisitors(page = 1, targetUserId?: string | number) {
  return request.post('/user/visitors', {
    page,
    ...(targetUserId ? { t_userid: targetUserId } : {}),
  });
}

export interface UserFollowMessageParams {
  tag?: string;
  id?: string | number;
  pagesize?: number;
  maxid?: string | number;
}

/**
 * 获取私信会话历史。已有会话传 tag，普通会话也可传对方 id。
 */
export function getUserFollowMessages(params: UserFollowMessageParams) {
  return request.get('/user/follow/message', {
    params,
  });
}

export interface SendUserFollowChatParams {
  tag?: string;
  tuid?: string | number;
  alert?: string;
  msgtype?: 201 | 202 | 205 | number;
  url?: string;
  thumbUrl?: string;
  imgFile?: string;
  nickname?: string;
  source?: number;
  followSource?: number;
  sourcePath?: string;
  width?: number;
  height?: number;
  isOriginal?: boolean;
  originalSize?: number;
  retry?: boolean;
}

/**
 * 发送私信。文本消息默认 msgtype=201；图片可传 url 或 imgFile(dataURL/base64)。
 */
export function sendUserFollowChat(params: SendUserFollowChatParams) {
  return request.post('/user/follow/chat', {
    ...params,
    follow_source: params.followSource,
    source_path: params.sourcePath,
    is_original: params.isOriginal,
    original_size: params.originalSize,
  });
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

/** 单独同步 lite v2 等级时长。 */
export function reportListenTime(options: { dSec: number; diffSec: number }) {
  return request.post(
    '/user/grade/info',
    {
      d_sec: options.dSec,
      diff_sec: options.diffSec,
    },
    { skipKugouVerification: true },
  );
}

/** 真实播放事件，禁用验证码后的自动重放，避免重复记账。 */
export function reportListeningEvent(options: {
  event: 'start' | 'end';
  mixsongid: number;
  duration?: number;
  state?: string;
}) {
  return request.post('/user/listen/report', options, { skipKugouVerification: true });
}

/**
 * 周期性独立写入听歌等级累计时长（与 CSCC 事件解耦），避免同段时长被重复计入。
 * 对接 /user/grade/info 的上报模式（d_sec=服务端当前基线，diff_sec=新增秒数）。
 */
export function reportGradeProgress(payload: { d_sec: number; diff_sec: number }) {
  return request.post('/user/grade/info', payload, { skipKugouVerification: true });
}

/**
 * 查询听歌等级信息（累计听歌时长/等级/积分）；显式 userid 可查询已保存账号。
 * 对接 /user/grade/info 的查询模式
 */
export function getUserGradeInfo(userid?: number) {
  return request.get(
    '/user/grade/info',
    userid === undefined
      ? undefined
      : { params: { userid }, skipUserAuth: true, skipKugouVerification: true },
  );
}

/**
 * 获取用户云盘
 */
export function getUserCloud(page = 1, pagesize = 30) {
  return request.get('/user/cloud', {
    params: { page, pagesize },
  });
}

const normalizeCloudSongId = (value: unknown): string | null => {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text) || /^0+$/.test(text)) return null;
  return text;
};

export interface DeleteCloudSongTarget {
  cloudFileId?: string | number;
  hash?: string;
  albumAudioId?: string | number;
}

const requestDeleteCloudSongs = async (params: Record<string, unknown>) => {
  try {
    return await request.get('/user/cloud/del', { params });
  } catch (error: any) {
    const msg = error?.response?.body?.msg;
    if (msg) throw new Error(String(msg));
    throw error;
  }
};

/**
 * 删除用户云盘歌曲。
 * 使用列表接口提供的云盘文件 ID（kv_id），上游不支持通过 hash 删除。
 */
export async function deleteCloudSongs(targets: DeleteCloudSongTarget[]) {
  const normalizedTargets = targets
    .map((target) => ({
      cloudFileId: normalizeCloudSongId(target.cloudFileId),
      albumAudioId: normalizeCloudSongId(target.albumAudioId),
    }))
    .filter((target) => target.cloudFileId);
  if (normalizedTargets.length === 0) throw new Error('缺少可删除的云盘文件标识');
  const response = await requestDeleteCloudSongs({
    fileids: normalizedTargets.map((target) => target.cloudFileId),
    album_audio_ids: normalizedTargets.map((target) => target.albumAudioId ?? 0),
  });
  const body =
    response && typeof response === 'object' ? (response as Record<string, unknown>) : null;
  const status = Number(body?.status ?? 1);
  const errorCode = Number(body?.error_code ?? 0);
  if (body && (status === 0 || errorCode !== 0)) {
    throw new Error(String(body.msg || `删除失败（error_code=${errorCode}）`));
  }
  return response;
}

const normalizeCloudUploadSongId = (value: unknown): string | number => {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return 0;
  return /^0+$/.test(text) ? 0 : text;
};

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
  const audioId = normalizeCloudUploadSongId(options.audioId);
  const albumAudioId = normalizeCloudUploadSongId(options.albumAudioId);
  try {
    const res = await request.post('/user/cloud/upload', data, {
      params: {
        extendname,
        name: baseName,
        ...(options.authorName ? { author_name: options.authorName } : {}),
        audio_id: audioId,
        album_audio_id: albumAudioId,
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
