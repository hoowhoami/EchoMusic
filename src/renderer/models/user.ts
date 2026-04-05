export interface UserExtendsInfo {
  detail?: Record<string, unknown>;
  vip?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface User {
  userid: number;
  token: string;
  username?: string;
  nickname?: string;
  mobile?: string;
  pic?: string;
  expires?: number;
  extends?: UserExtendsInfo;
  extendsInfo?: UserExtendsInfo;

  userId?: number;
  userName?: string;
  userPic?: string;
  t1?: string;
  vip_type?: number;
  p_grade?: number;
  detail?: Record<string, unknown>;
  vip?: Record<string, unknown>;
}

export type UserPatch = Partial<User>;
