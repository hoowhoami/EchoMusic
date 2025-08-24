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
