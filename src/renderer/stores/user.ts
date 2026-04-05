import { defineStore } from 'pinia';
import { claimDayVip, getUserDetail, getUserVipDetail, getVipMonthRecord, upgradeDayVip } from '@/api/user';
import type { User, UserExtendsInfo } from '@/models/user';
import { mapUser } from '@/utils/mappers';
import logger from '@/utils/logger';
import { useToastStore } from './toast';

export type UserInfo = User;

interface ApiPayload {
  status?: number;
  data?: unknown;
  [key: string]: unknown;
}

const asApiPayload = (value: unknown): ApiPayload | null => {
  if (!value || typeof value !== 'object') return null;
  return value as ApiPayload;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const mergeExtendsInfo = (...sources: Array<UserExtendsInfo | undefined>): UserExtendsInfo | undefined => {
  const merged = sources.reduce<UserExtendsInfo>((acc, source) => {
    if (!source) return acc;
    return {
      ...acc,
      ...source,
      detail: isRecord(source.detail)
        ? {
            ...(isRecord(acc.detail) ? acc.detail : {}),
            ...source.detail,
          }
        : acc.detail,
      vip: isRecord(source.vip)
        ? {
            ...(isRecord(acc.vip) ? acc.vip : {}),
            ...source.vip,
          }
        : acc.vip,
    };
  }, {});

  return Object.keys(merged).length > 0 ? merged : undefined;
};

const normalizeUserInfo = (info: UserInfo): UserInfo => {
  const next = { ...info };

  if ((typeof next.userid !== 'number' || next.userid <= 0) && typeof next.userId === 'number' && next.userId > 0) {
    next.userid = next.userId;
  }
  if ((typeof next.userId !== 'number' || next.userId <= 0) && typeof next.userid === 'number' && next.userid > 0) {
    next.userId = next.userid;
  }

  return next;
};

const buildPatchedUserInfo = (current: UserInfo | null, patch: Partial<UserInfo>): UserInfo => {
  return normalizeUserInfo({
    ...(current ?? { userid: 0, token: '' }),
    ...patch,
  });
};



export const useUserStore = defineStore('user', {
  state: () => ({
    info: null as UserInfo | null,
    isLoggedIn: false,
    hasFetchedUserInfo: false,
    isFetchingUserInfo: false,
    isTvipClaimedToday: false,
    isSvipClaimedToday: false,
    isAutoClaimingVip: false,
  }),
  actions: {
    setUserInfo(info: UserInfo) {
      const nextInfo = normalizeUserInfo(info);
      this.$patch((state) => {
        state.info = nextInfo;
        state.isLoggedIn = !!nextInfo.token;
        if (!nextInfo.token) {
          state.hasFetchedUserInfo = false;
        }
      });
    },
    handleLoginSuccess(data: Record<string, unknown>) {
      this.hasFetchedUserInfo = false;

      const mapped = mapUser(data);
      const detailPayload = isRecord(data.detail)
        ? data.detail
        : isRecord(data.extendsInfo) && isRecord((data.extendsInfo as Record<string, unknown>).detail)
          ? ((data.extendsInfo as Record<string, unknown>).detail as Record<string, unknown>)
          : isRecord(data)
            ? data
            : undefined;

      const vipPayload = isRecord(data.vip)
        ? data.vip
        : isRecord(data.extendsInfo) && isRecord((data.extendsInfo as Record<string, unknown>).vip)
          ? ((data.extendsInfo as Record<string, unknown>).vip as Record<string, unknown>)
          : undefined;

      const mergedExtends = mergeExtendsInfo(
        this.info?.extendsInfo,
        mapped.extendsInfo,
        detailPayload ? { detail: detailPayload } : undefined,
        vipPayload ? { vip: vipPayload } : undefined,
      );

      const nextInfo = buildPatchedUserInfo(this.info, {
        ...mapped,
        ...(mergedExtends
          ? {
              extends: mergedExtends,
              extendsInfo: mergedExtends,
              ...(mergedExtends.detail ? { detail: mergedExtends.detail } : {}),
              ...(mergedExtends.vip ? { vip: mergedExtends.vip } : {}),
            }
          : {}),
      });

      this.setUserInfo(nextInfo);
    },
    async fetchUserInfo() {
      if (!this.isLoggedIn) return;
      try {
        const [detailRes, vipRes] = await Promise.all([getUserDetail(), getUserVipDetail()]);
        const detailPayload = asApiPayload(detailRes);
        const vipPayload = asApiPayload(vipRes);

        if (detailPayload?.status === 1) {
          logger.info('UserStore', 'User detail fetched');
          const payload =
            detailPayload.data && typeof detailPayload.data === 'object'
              ? (detailPayload.data as Record<string, unknown>)
              : detailPayload;
          this.handleLoginSuccess(payload);
        }

        if (vipPayload?.status === 1 && this.info) {
          logger.info('UserStore', 'VIP detail fetched');
          const vipData =
            vipPayload.data && typeof vipPayload.data === 'object'
              ? (vipPayload.data as Record<string, unknown>)
              : undefined;
          const mergedExtends = mergeExtendsInfo(
            this.info.extendsInfo,
            vipData ? { vip: vipData } : undefined,
          );

          this.setUserInfo(buildPatchedUserInfo(this.info, {
            ...(vipData ? { vip: vipData } : {}),
            ...(mergedExtends ? { extends: mergedExtends, extendsInfo: mergedExtends } : {}),
          }));
        }
      } catch (e) {
        logger.error('UserStore', 'Fetch user info error:', e);
      }
    },
    async fetchUserInfoOnce() {
      if (!this.isLoggedIn || this.hasFetchedUserInfo || this.isFetchingUserInfo) return;
      this.isFetchingUserInfo = true;
      try {
        await this.fetchUserInfo();
        this.hasFetchedUserInfo = true;
      } finally {
        this.isFetchingUserInfo = false;
      }
    },

    async autoReceiveVipIfNeeded() {
      if (!this.isLoggedIn || this.isAutoClaimingVip) return;
      this.isAutoClaimingVip = true;
      const toastStore = useToastStore();
      try {
        if (!this.info) {
          await this.fetchUserInfo();
        }

        const today = new Date().toISOString().split('T')[0];
        const recordRes = await getVipMonthRecord();
        const recordList = Array.isArray(recordRes?.data?.list)
          ? (recordRes.data.list as Array<Record<string, unknown>>)
          : [];
        let isTvipClaimed = recordList.some((item) => String(item.day ?? '') === today);

        if (!isTvipClaimed) {
          const claimRes = await claimDayVip(today) as { status?: number };
          isTvipClaimed = claimRes?.status === 1;
        }

        const vipInfo = (this.info?.extendsInfo?.vip ?? this.info?.vip ?? {}) as Record<string, unknown>;
        const busiVip = Array.isArray(vipInfo.busi_vip) ? (vipInfo.busi_vip as Array<Record<string, unknown>>) : [];
        const hasSvip = busiVip.some((item) => item.product_type === 'svip' && Number(item.is_vip ?? 0) === 1);

        let isSvipClaimed = hasSvip;
        if (isTvipClaimed && !hasSvip) {
          const upgradeRes = await upgradeDayVip() as { status?: number; error_code?: number };
          isSvipClaimed = upgradeRes?.status === 1 || upgradeRes?.error_code === 297002;
        }

        this.setClaimStatus(isTvipClaimed, isSvipClaimed);
        if (isTvipClaimed || isSvipClaimed) {
          await this.fetchUserInfo();
        }
      } catch (error) {
        logger.warn('UserStore', 'Auto receive VIP skipped:', error);
        toastStore.actionFailed('领取 VIP');
      } finally {
        this.isAutoClaimingVip = false;
      }
    },

    setClaimStatus(tvip: boolean, svip: boolean) {
      this.isTvipClaimedToday = tvip;
      this.isSvipClaimedToday = svip;
    },
    logout() {
      this.info = null;
      this.isLoggedIn = false;
      this.hasFetchedUserInfo = false;
      this.isFetchingUserInfo = false;
      this.isTvipClaimedToday = false;
      this.isSvipClaimedToday = false;
      this.isAutoClaimingVip = false;
    },
  },
  persist: {
    omit: ['hasFetchedUserInfo', 'isFetchingUserInfo', 'isAutoClaimingVip'],
  },
});
