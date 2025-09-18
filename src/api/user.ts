import { api } from '@/utils/request';

// 发送验证码
// 说明: 调用此接口 ,传入手机号码, 可发送验证码
export const captchaSent = (mobile: string) => {
  return api.get('/captcha/sent', { mobile });
};

// 手机登录
// 必选参数 mobile: 手机号码 code: 验证码，使用 /captcha/sent接口传入手机号获取验证码,调用此接口传入验证码,可使用验证码登录
// 可选参数 userid: 用户 id,当用户存在多个账户是 时，必须加上需要登录的用户 id
export const loginCellphone = (mobile: string, code: string) => {
  return api.get('/login/cellphone', { mobile, code });
};

// 二维码 key 生成接口
// 说明: 调用此接口可生成一个 key
export const loginQrKey = () => {
  return api.get('/login/qr/key');
};

// 二维码生成接口
// 说明: 调用此接口传入上一个接口生成的 key 可生成二维码图片的 base64 和二维码信息,可使用 base64 展示图片,或者使用二维码信息内容自行使用第三方二维码生成 库渲染二维码
// key: 由第一个接口生成
// 可选参数 qrimg: 传入后会额外返回二维码图片 base64 编码
export const loginQrCreate = (key: string, qrimg: boolean = true) => {
  return api.get('/login/qr/create', {
    key,
    qrimg,
  });
};

// 二维码检测扫码状态接口
// 说明: 轮询此接口可获取二维码扫码状态
// 0 为二维码过期，1 为等待扫码，2 为待确认，4 为授权登录成功（4 状态码下会返回 token）
export const loginQrCheck = (key: string) => {
  return api.get('/login/qr/check', {
    key,
  });
};

// 刷新登录
// 说明 : 调用此接口，可刷新登录状态，可以延长 token 过期时间
// token: 登录后获取的 token
// userid: 用户 id
export const refreshToken = (userid: number, token: string) => {
  return api.get('/login/token', {
    userid,
    token,
  });
};

// dfid 获取
export const dfid = () => {
  return api.get('/register/dev');
};

// 获取用户额外信息
// 说明：登陆后调用此接口，可以获取用户额外信息
export const userDetail = () => {
  return api.get('/user/detail');
};

// 获取用户 vip 信息
// 说明：登陆后调用此接口，可以获取用户 vip 信息
export const userVipDetail = () => {
  return api.get('/user/vip/detail');
};

// 领取 VIP（需要登陆，该接口为测试接口,仅限概念版使用）
// 说明 : 调用此接口 , 每天可领取 1 天 VIP 时长，需要领取 8 次，每次增加 3 小时
// 该接口来自 KG 概念版，非会员用户需要自行测试是否可用(尽量别频繁调用)
export const youthVip = () => {
  return api.get('/youth/vip');
};

// 领取一天 VIP（需要登陆，该接口为测试接口,仅限概念版使用）
// 说明 : 调用此接口 , 每天可领取 1 天 VIP 时长
// 该接口来自 KG 概念版，非会员用户需要自行测试是否可用(尽量别频繁调用)
export const youthDayVip = () => {
  return api.get('/youth/day/vip');
};

// 获取当月已领取 VIP 天数（需要登陆，该接口为测试接口,仅限概念版使用）
// 说明 : 调用此接口 ,获取当月已领取 VIP 天数
export const youthMonthVipRecord = () => {
  return api.get('/youth/month/vip/record');
};

// 获取已领取 VIP 状态（需要登陆，该接口为测试接口,仅限概念版使用）
// 说明 : 调用此接口 ,获取已领取 VIP 状态
export const youthUnionVip = () => {
  return api.get('/youth/union/vip');
};

// 获取用户关注的歌手/用户
// 说明：登录后调用此接口，可以获取用户的所有关注的歌手/用户
export const getUserFollow = () => {
  return api.get('/user/follow');
};

// 获取用户最近听歌历史
// 说明：登录后调用此接口，可以近期的听歌历史记录(需要登陆)
// 可选参数：
// bp: 可以更加上一次返回值传入
export const getUserPlayHistory = (bp?: number) => {
  return api.get('/user/history', { bp });
};

// 提交听歌历史
// 说明：提交听歌历史后，支持在其他设备上查看听歌历史
// 必选参数
// mxid： 专辑音乐 id (album_audio_id/MixSongID 均可以)
// 可选参数：
// ot：当前时间戳, 秒级，不要传入毫秒级，否者会返回错误，或者从 获取服务器时间 中获取
// pc: 当前播放次数，更新播放次数，当服务器的值大于传入值时，将维持服务最大值，否则更新
export const uploadPlayHistory = (mxid: number) => {
  return api.get('/playhistory/upload', { mxid });
};

// 获取用户云盘
// 说明：登录后调用此接口可以获取用户上传到云盘的音乐（需要登录）
// 可选参数
// page : 页数
// pagesize : 每页页数, 默认为 30
export const getUserCloud = (page?: number, pagesize: number = 30) => {
  return api.get('/user/cloud', { page, pagesize });
};

// 获取用户云盘音乐 URL
// 说明：登录后调用此接口可以获取用户上传到云盘的音乐 URL，部分可以直接用 /song/url 直接获取 URL（需要登录，目前获取到的文件大小都约为 10M 左右）
// 必选参数：
// hash: 音乐 hash
// 可选参数：
// album_id: 专辑 id
// name: 云盘音乐名称
// album_audio_id：专辑音频 id
export const getCloudSongUrl = (hash: string) => {
  return api.get('/user/cloud/url', { hash });
};
