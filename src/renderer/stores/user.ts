import { defineStore } from 'pinia';
import { claimDayVip, getServerNow, getUserDetail, getUserVipDetail, upgradeDayVip } from '@/api/user';
import type { User, UserExtendsInfo } from '@/models/user';
import { mapUser } from '@/utils/mappers';
import logger from '@/utils/logger';

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

const mergeExtendsInfo = (
  ...sources: Array<UserExtendsInfo | undefined>
): UserExtendsInfo | undefined => {
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

  if (
    (typeof next.userid !== 'number' || next.userid <= 0) &&
    typeof next.userId === 'number' &&
    next.userId > 0
  ) {
    next.userid = next.userId;
  }
  if (
    (typeof next.userId !== 'number' || next.userId <= 0) &&
    typeof next.userid === 'number' &&
    next.userid > 0
  ) {
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
        : isRecord(data.extendsInfo) &&
            isRecord((data.extendsInfo as Record<string, unknown>).detail)
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

          this.setUserInfo(
            buildPatchedUserInfo(this.info, {
              ...(vipData ? { vip: vipData } : {}),
              ...(mergedExtends ? { extends: mergedExtends, extendsInfo: mergedExtends } : {}),
            }),
          );
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

      try {
        // 使用服务器时间获取日期，避免本地时区导致日期不一致
        const today = await this.getServerToday();

        // 尝试领取
        try {
          await claimDayVip(today);
        } catch (e) {
          logger.warn('UserStore', 'VIP claim: claimDayVip failed', e);
        }

        // 尝试升级
        try {
          await upgradeDayVip();
        } catch (e) {
          logger.warn('UserStore', 'VIP claim: upgradeDayVip failed', e);
        }

        // 刷新用户信息
        try {
          await this.fetchUserInfo();
          this.hasFetchedUserInfo = true;
        } catch (e) {
          logger.warn('UserStore', 'VIP claim: fetchUserInfo failed', e);
        }
      } catch (error) {
        logger.warn('UserStore', 'Auto receive VIP unexpected error:', error);
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

    async getServerToday(): Promise<string> {
      try {
        const res = await getServerNow();
        if (res && typeof res === 'object') {
          const record = res as Record<string, unknown>;
          const source = (
            record.data && typeof record.data === 'object' ? record.data : record
          ) as Record<string, unknown>;
          const candidates = [
            source.now,
            source.time,
            source.timestamp,
            source.server_time,
            source.serverTime,
          ];
          for (const candidate of candidates) {
            const value = Number(candidate);
            if (Number.isFinite(value) && value > 0) {
              // 服务器返回的是秒级或毫秒级时间戳
              const ms = value > 1e12 ? value : value * 1000;
              // 使用北京时间（UTC+8）格式化日期
              const date = new Date(ms);
              const offset = 8 * 60;
              const local = new Date(date.getTime() + offset * 60 * 1000);
              return local.toISOString().split('T')[0];
            }
          }
        }
      } catch (e) {
        logger.warn('UserStore', 'Failed to get server time, using local time', e);
      }
      // 兜底：使用本地时间（北京时间）
      const now = new Date();
      const offset = 8 * 60;
      const local = new Date(now.getTime() + offset * 60 * 1000);
      return local.toISOString().split('T')[0];
    },
  },
  persist: {
    omit: ['hasFetchedUserInfo', 'isFetchingUserInfo', 'isAutoClaimingVip'],
  },
});
