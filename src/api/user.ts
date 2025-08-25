import { api } from '@/utils/request';

export function captchaSent(mobile: string) {
  return api.get('/captcha/sent', { mobile });
}

export function loginCellphone(mobile: string, code: string) {
  return api.get('/login/cellphone', { mobile, code });
}

export function loginQrKey() {
  return api.get('/login/qr/key');
}

export function loginQrCreate(key: string, qrimg: boolean = true) {
  return api.get('/login/qr/create', {
    key,
    qrimg,
  });
}

export function loginQrCheck(key: string) {
  return api.get('/login/qr/check', {
    key,
  });
}

export function refreshToken(userid: number, token: string) {
  return api.get('/login/token', {
    userid,
    token,
  });
}

export function dfid() {
  return api.get('/register/dev');
}

export function userDetail() {
  return api.get('/user/detail');
}

export function userVipDetail() {
  return api.get('/user/vip/detail');
}
