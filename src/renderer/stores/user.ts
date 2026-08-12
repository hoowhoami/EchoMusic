import { defineStore } from 'pinia';
import { getUserDetail, getUserFollow, getUserGradeInfo, getUserVipDetail } from '@/api/user';
import { useListenReportStore } from '@/stores/listenReport';
import type { User, UserExtendsInfo } from '@/models/user';
import { mapUser } from '@/utils/mappers';
import logger from '@/utils/logger';

export type UserInfo = User;

// 听歌等级字段白名单：合并进用户档案 detail 时仅取这些字段，
// 避免覆盖档案原有字段（如 detail.duration 的语义/单位与 grade duration 不同）
const GRADE_DETAIL_KEYS = [
  'd_sec',
  'p_grade',
  'p_current_point',
  'p_grade_point',
  'p_next_grade',
  'p_next_grade_point',
] as const;

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
    followedArtistIds: new Set<string>(),
    hasFetchedFollowedArtists: false,
  }),
  actions: {
    setUserInfo(info: UserInfo) {
      const previousUserKey = String(this.info?.userid ?? this.info?.userId ?? '');
      const nextInfo = normalizeUserInfo(info);
      const nextUserKey = String(nextInfo.userid ?? nextInfo.userId ?? '');
      this.$patch((state) => {
        if (previousUserKey && nextUserKey && previousUserKey !== nextUserKey) {
          state.followedArtistIds = new Set();
          state.hasFetchedFollowedArtists = false;
        }
        state.info = nextInfo;
        state.isLoggedIn = !!nextInfo.token;
        if (!nextInfo.token) {
          state.hasFetchedUserInfo = false;
          state.followedArtistIds = new Set();
          state.hasFetchedFollowedArtists = false;
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

    /**
     * 获取听歌等级信息（累计时长/等级/积分），合并进 extendsInfo.detail，
     * 供 Profile / Sidebar 展示最新 Lv 与积分。
     */
    async fetchGradeInfo() {
      if (!this.isLoggedIn || !this.info) return;
      try {
        const res = await getUserGradeInfo();
        const payload = asApiPayload(res);
        if (payload?.status !== 1) return;

        const gradeData = isRecord(payload.data) ? payload.data : {};
        // 仅取等级相关白名单字段合并，避免覆盖档案既有字段（如 detail.duration）
        const gradeDetail = Object.fromEntries(
          GRADE_DETAIL_KEYS.filter((key) => key in gradeData).map((key) => [key, gradeData[key]]),
        );
        if (Object.keys(gradeDetail).length === 0) return;

        const currentDetail = isRecord(this.info.extendsInfo?.detail)
          ? (this.info.extendsInfo.detail as Record<string, unknown>)
          : {};
        const mergedExtends = mergeExtendsInfo(this.info.extendsInfo, {
          detail: { ...currentDetail, ...gradeDetail },
        });

        this.setUserInfo(
          buildPatchedUserInfo(this.info, {
            ...(mergedExtends
              ? {
                  extends: mergedExtends,
                  extendsInfo: mergedExtends,
                  ...(mergedExtends.detail ? { detail: mergedExtends.detail } : {}),
                }
              : {}),
          }),
        );
        logger.info('UserStore', 'Grade info fetched');
      } catch (e) {
        logger.warn('UserStore', 'Fetch grade info error:', e);
      }
    },

    logout() {
      this.info = null;
      this.isLoggedIn = false;
      this.hasFetchedUserInfo = false;
      this.isFetchingUserInfo = false;
      this.followedArtistIds = new Set();
      this.hasFetchedFollowedArtists = false;
      // 清空听歌时长上报状态，避免跨账号串号
      useListenReportStore().reset();
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
  },
  persist: {
    omit: [
      'hasFetchedUserInfo',
      'isFetchingUserInfo',
      'followedArtistIds',
      'hasFetchedFollowedArtists',
    ],
  },
});
