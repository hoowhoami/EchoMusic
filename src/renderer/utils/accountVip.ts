export interface VipProduct {
  product_type?: string;
  is_vip?: number | string | boolean;
  vip_begin_time?: string | number;
  vip_end_time?: string | number;
}

export interface AccountVipInfo {
  vip_type?: number | string;
  user_type?: number | string;
  vip_begin_time?: string | number;
  vip_end_time?: string | number;
  su_vip_begin_time?: string | number;
  su_vip_end_time?: string | number;
  busi_vip?: VipProduct[];
  [key: string]: unknown;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** KugouYoung 5.1.9: n.b(user_type) is Super VIP; UserInfoFragment.ee(vip_type=6) is Deluxe VIP. */
export const getAccountVipStatus = (value: unknown) => {
  const info = record(value);
  const userType = Number(info.user_type);
  const products = Array.isArray(info.busi_vip) ? info.busi_vip.map(record) : [];
  const activeProduct = (type: string): VipProduct | undefined =>
    products.find((product) => product.product_type === type && Number(product.is_vip) === 1) as
      VipProduct | undefined;
  return {
    superVip: Number.isInteger(userType) && userType >= 0 && (userType & 16) !== 0,
    deluxeVip: Number(info.vip_type) === 6,
    conceptVip: activeProduct('svip'),
    musicVip: activeProduct('tvip'),
  };
};

export const getPrimaryVipBadge = (status: ReturnType<typeof getAccountVipStatus>) => {
  if (status.superVip) return { kind: 'super', label: '超级VIP' };
  if (status.deluxeVip) return { kind: 'deluxe', label: '豪华VIP' };
  if (status.conceptVip) return { kind: 'concept', label: '概念VIP' };
  if (status.musicVip) return { kind: 'music', label: '畅听VIP' };
  return null;
};
