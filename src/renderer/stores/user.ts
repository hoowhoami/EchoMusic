import { defineStore } from 'pinia';
import {
  claimDayVip,
  getServerNow,
  getUserDetail,
  getUserFollow,
  getUserVipDetail,
  upgradeDayVip,
} from '@/api/user';
import type { User, UserExtendsInfo } from '@/models/user';
import { mapUser } from '@/utils/mappers';
import logger from '@/utils/logger';

export type UserInfo = User;

interface ApiPayload {
  status?: number;
  data?: unknown;
  [key: string]: unknown;
}

interface VipActionResponse {
  status?: number;
  error_code?: number;
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
    followedArtistIds: new Set<string>(),
    hasFetchedFollowedArtists: false,
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

        return true;
      } catch (e) {
        logger.error('UserStore', 'Fetch user info error:', e);
        return false;
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
        const today = await this.getServerToday();

        try {
          const result = (await claimDayVip(today)) as VipActionResponse;
          if (result.status !== 1) {
            logger.warn(
              'UserStore',
              'VIP claim: claimDayVip returned an unsuccessful status',
              result,
            );
          }
        } catch (error) {
          logger.warn('UserStore', 'VIP claim: claimDayVip failed', error);
        }

        try {
          const result = (await upgradeDayVip()) as VipActionResponse;
          if (result.status !== 1 && result.error_code !== 297002) {
            logger.warn(
              'UserStore',
              'VIP claim: upgradeDayVip returned an unsuccessful status',
              result,
            );
          }
        } catch (error) {
          logger.warn('UserStore', 'VIP claim: upgradeDayVip failed', error);
        }

        await this.fetchUserInfo();
        this.hasFetchedUserInfo = true;
      } catch (error) {
        logger.warn('UserStore', 'Auto receive VIP failed', error);
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
      this.followedArtistIds = new Set();
      this.hasFetchedFollowedArtists = false;
    },

    isArtistFollowed(artistId: string | number): boolean {
      return this.followedArtistIds.has(String(artistId));
    },

    addFollowedArtist(artistId: string | number) {
      this.followedArtistIds = new Set([...this.followedArtistIds, String(artistId)]);
    },

    removeFollowedArtist(artistId: string | number) {
      const next = new Set(this.followedArtistIds);
      next.delete(String(artistId));
      this.followedArtistIds = next;
    },

    async fetchFollowedArtists() {
      if (!this.isLoggedIn) return;
      try {
        const res = await getUserFollow();
        if (res && typeof res === 'object' && 'data' in res) {
          const data = (res as { data?: { lists?: unknown[] } }).data;
          const lists = Array.isArray(data?.lists) ? data.lists : [];
          const ids = new Set<string>();
          for (const item of lists) {
            const record = item as Record<string, unknown>;
            const id = String(record.singerid ?? record.userid ?? record.id ?? '');
            if (id) ids.add(id);
          }
          this.followedArtistIds = ids;
          this.hasFetchedFollowedArtists = true;
        }
      } catch (e) {
        logger.warn('UserStore', 'Fetch followed artists failed', e);
      }
    },

    async ensureFollowedArtists() {
      if (this.hasFetchedFollowedArtists) return;
      await this.fetchFollowedArtists();
    },

    async getServerToday(): Promise<string> {
      const toBeijingDate = (timestamp: number) => {
        const milliseconds = timestamp > 1e12 ? timestamp : timestamp * 1000;
        return new Date(new Date(milliseconds).getTime() + 8 * 60 * 60 * 1000)
          .toISOString()
          .split('T')[0];
      };

      try {
        const response = await getServerNow();
        if (response && typeof response === 'object') {
          const record = response as Record<string, unknown>;
          const source =
            record.data && typeof record.data === 'object'
              ? (record.data as Record<string, unknown>)
              : record;
          const timestamp = [
            source.now,
            source.time,
            source.timestamp,
            source.server_time,
            source.serverTime,
          ]
            .map(Number)
            .find((value) => Number.isFinite(value) && value > 0);
          if (timestamp) return toBeijingDate(timestamp);
        }
      } catch (error) {
        logger.warn('UserStore', 'Failed to get server time, using local time', error);
      }

      return toBeijingDate(Date.now());
    },
  },
  persist: {
    omit: [
      'hasFetchedUserInfo',
      'isFetchingUserInfo',
      'isAutoClaimingVip',
      'followedArtistIds',
      'hasFetchedFollowedArtists',
    ],
  },
});
