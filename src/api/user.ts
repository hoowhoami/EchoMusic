import { api } from '@/utils/request';

export const captchaSent = (mobile: string) => {
  return api.get('/captcha/sent', { mobile });
};

export const loginCellphone = (mobile: string, code: string) => {
  return api.get('/login/cellphone', { mobile, code });
};

export const loginQrKey = () => {
  return api.get('/login/qr/key');
};

export const loginQrCreate = (key: string, qrimg: boolean = true) => {
  return api.get('/login/qr/create', {
    key,
    qrimg,
  });
};

export const loginQrCheck = (key: string) => {
  return api.get('/login/qr/check', {
    key,
  });
};

export const refreshToken = (userid: number, token: string) => {
  return api.get('/login/token', {
    userid,
    token,
  });
};

export const dfid = () => {
  return api.get('/register/dev');
};

export const userDetail = () => {
  return api.get('/user/detail');
};

export const userVipDetail = () => {
  return api.get('/user/vip/detail');
};
