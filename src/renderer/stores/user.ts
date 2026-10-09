import { defineStore } from 'pinia';
import {
  getUserDetail,
  getUserFollow,
  getUserGradeInfo,
  getUserVipDetail,
  updateUserAvatar,
  updateUserProfile,
  type UpdateUserProfileParams,
} from '@/api/user';
import { useListenReportStore } from '@/stores/listenReport';
import type { User, UserExtendsInfo } from '@/models/user';
import { mapUser } from '@/utils/mappers';
import logger from '@/utils/logger';

export type UserInfo = User;

export type SavedAccount = Pick<
  User,
  'userid' | 'token' | 't1' | 'nickname' | 'pic' | 'expires'
> & {
  lastUsedAt: number;
  listeningSeconds?: number;
};

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

const readMutationString = (payload: Record<string, unknown>, key: string): string => {
  const direct = payload[key];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const data = isRecord(payload.data) ? payload.data[key] : undefined;
  return typeof data === 'string' ? data.trim() : '';
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
    accountRevision: 0,
    userInfoRevision: 0,
    savedAccounts: [] as SavedAccount[],
  }),
  actions: {
    rememberAccount(info: UserInfo | null, used = false) {
      if (!info || !Number.isSafeInteger(info.userid) || info.userid <= 0 || !info.token) return;
      const existing = this.savedAccounts.find((account) => account.userid === info.userid);
      const account: SavedAccount = {
        userid: info.userid,
        token: info.token,
        t1: info.t1,
        nickname: info.nickname,
        pic: info.pic,
        expires: info.expires,
        lastUsedAt: used ? Date.now() : (existing?.lastUsedAt ?? Date.now()),
        ...(existing?.listeningSeconds !== undefined
          ? { listeningSeconds: existing.listeningSeconds }
          : {}),
      };
      this.savedAccounts = [
        account,
        ...this.savedAccounts.filter((saved) => saved.userid !== account.userid),
      ];
    },
    updateSavedAccountListeningSeconds(userid: number, value: unknown) {
      if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return;
      const seconds = Number(value);
      if (!Number.isFinite(seconds) || seconds < 0) return;
      this.savedAccounts = this.savedAccounts.map((account) =>
        account.userid === userid ? { ...account, listeningSeconds: seconds } : account,
      );
    },
    /** 登录与切换共用入口；仅恢复凭证，账号资料由正常初始化重新获取。 */
    login(data: Record<string, unknown>) {
      const mapped = mapUser(data);
      if (
        !mapped.userid ||
        !Number.isSafeInteger(mapped.userid) ||
        mapped.userid <= 0 ||
        !mapped.token
      ) {
        throw new Error('登录信息不完整，请重新登录');
      }
      if (this.isLoggedIn) this.rememberAccount(this.info);
      this.handleLoginSuccess(data, true);
      this.rememberAccount(this.info, true);
      useListenReportStore().reset();
      void this.fetchUserInfoOnce();
    },
    switchAccount(userid: number) {
      if (this.isLoggedIn && this.info?.userid === userid) return;
      const account = this.savedAccounts.find((saved) => saved.userid === userid);
      if (!account) throw new Error('账号已移除，请重新登录');
      this.login({ ...account });
    },
    forgetAccount(userid: number) {
      if (this.isLoggedIn && this.info?.userid === userid) {
        throw new Error('当前登录账号不能移除，请先切换账号');
      }
      this.savedAccounts = this.savedAccounts.filter((account) => account.userid !== userid);
    },
    setUserInfo(info: UserInfo, newSession = false) {
      const previousUserKey = String(this.info?.userid ?? this.info?.userId ?? '');
      const nextInfo = normalizeUserInfo(info);
      const nextUserKey = String(nextInfo.userid ?? nextInfo.userId ?? '');
      this.$patch((state) => {
        if (newSession || previousUserKey !== nextUserKey || state.info?.token !== nextInfo.token) {
          state.accountRevision += 1;
          state.hasFetchedUserInfo = false;
          state.isFetchingUserInfo = false;
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
      // 资料刷新只更新已保存的账号，不在启动恢复时迁移当前账号。
      if (this.savedAccounts.some((account) => account.userid === nextInfo.userid)) {
        this.rememberAccount(nextInfo);
      }
    },
    handleLoginSuccess(data: Record<string, unknown>, newSession = false) {
      this.hasFetchedUserInfo = false;

      const mapped = mapUser(data);
      const current =
        newSession || (mapped.userid && mapped.userid !== this.info?.userid) ? null : this.info;
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
        current?.extendsInfo,
        mapped.extendsInfo,
        detailPayload ? { detail: detailPayload } : undefined,
        vipPayload ? { vip: vipPayload } : undefined,
      );

      const nextInfo = buildPatchedUserInfo(current, {
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

      this.setUserInfo(nextInfo, newSession);
    },
    async fetchUserInfo() {
      if (!this.isLoggedIn) return;
      const revision = this.accountRevision;
      try {
        const [detailRes, vipRes] = await Promise.allSettled([getUserDetail(), getUserVipDetail()]);
        if (!this.isLoggedIn || revision !== this.accountRevision) return false;
        const detailPayload = asApiPayload(
          detailRes.status === 'fulfilled' ? detailRes.value : null,
        );
        const vipPayload = asApiPayload(vipRes.status === 'fulfilled' ? vipRes.value : null);
        for (const result of [detailRes, vipRes]) {
          if (result.status === 'rejected')
            logger.warn('UserStore', 'User info request failed:', result.reason);
        }

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

        // 同一账号刷新成功也通知依赖账号权益的缓存；登录会话编号保持独立。
        if (detailPayload?.status === 1 || vipPayload?.status === 1) {
          this.userInfoRevision += 1;
        }
        return detailPayload?.status === 1;
      } catch (e) {
        logger.error('UserStore', 'Fetch user info error:', e);
        return false;
      }
    },
    async fetchUserInfoOnce() {
      if (!this.isLoggedIn || this.hasFetchedUserInfo || this.isFetchingUserInfo) return;
      const revision = this.accountRevision;
      this.isFetchingUserInfo = true;
      try {
        const success = await this.fetchUserInfo();
        if (revision === this.accountRevision && this.isLoggedIn)
          this.hasFetchedUserInfo = !!success;
      } finally {
        if (revision === this.accountRevision) this.isFetchingUserInfo = false;
      }
    },

    async updateProfile(params: UpdateUserProfileParams) {
      if (!this.isLoggedIn || !this.info) throw new Error('请先登录后再修改个人资料');
      const revision = this.accountRevision;

      await updateUserProfile(params);
      if (!this.isLoggedIn || !this.info || revision !== this.accountRevision) return;

      const currentDetail = isRecord(this.info.extendsInfo?.detail)
        ? (this.info.extendsInfo.detail as Record<string, unknown>)
        : {};
      const nextDetail: Record<string, unknown> = { ...currentDetail };
      if (params.sex !== undefined) nextDetail.gender = params.sex;
      if (params.birthday !== undefined) nextDetail.birthday = params.birthday;
      if (params.signature !== undefined) {
        nextDetail.descri = params.signature;
        nextDetail.signature = params.signature;
      }
      if (params.province !== undefined) nextDetail.province = params.province;
      if (params.city !== undefined) nextDetail.city = params.city;
      if (params.memo !== undefined) nextDetail.memo = params.memo;
      if (params.tags !== undefined) nextDetail.tags = params.tags;

      const mergedExtends = mergeExtendsInfo(this.info.extendsInfo, { detail: nextDetail });
      this.setUserInfo(
        buildPatchedUserInfo(this.info, {
          ...(params.nickname ? { nickname: params.nickname, userName: params.nickname } : {}),
          detail: nextDetail,
          ...(mergedExtends ? { extends: mergedExtends, extendsInfo: mergedExtends } : {}),
        }),
      );
    },

    async updateAvatar(dataUrl: string, filename?: string) {
      if (!this.isLoggedIn || !this.info) throw new Error('请先登录后再修改头像');
      const revision = this.accountRevision;

      const response = await updateUserAvatar(dataUrl, filename);
      const pic = readMutationString(response, 'pic');
      if (pic && this.isLoggedIn && revision === this.accountRevision) {
        this.setUserInfo(buildPatchedUserInfo(this.info, { pic, userPic: pic }));
      }
      return { pic, reviewPending: Boolean(response.reviewPending) };
    },

    /**
     * 获取听歌等级信息（累计时长/等级/积分），合并进 extendsInfo.detail，
     * 供 Profile / Sidebar 展示最新 Lv 与积分。
     */
    async fetchGradeInfo() {
      if (!this.isLoggedIn || !this.info) return;
      const revision = this.accountRevision;
      try {
        const res = await getUserGradeInfo();
        if (!this.isLoggedIn || !this.info || revision !== this.accountRevision) return;
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
        this.updateSavedAccountListeningSeconds(this.info.userid, gradeData.d_sec);
      } catch (e) {
        logger.warn('UserStore', 'Fetch grade info error:', e);
      }
    },

    logout() {
      // 主动退出不能留下可直接恢复的当前账号凭证，其他账号继续保留。
      this.savedAccounts = this.savedAccounts.filter(
        (account) => account.userid !== this.info?.userid,
      );
      this.accountRevision += 1;
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
      const revision = this.accountRevision;
      try {
        const res = await getUserFollow();
        if (!this.isLoggedIn || revision !== this.accountRevision) return;
        if (res && typeof res === 'object' && 'data' in res) {
          const data = (res as { data?: { lists?: unknown[] } }).data;
          const lists = Array.isArray(data?.lists) ? data.lists : [];
          const ids = new Set<string>();
          for (const item of lists) {
            if (!isRecord(item)) continue;
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
      'accountRevision',
      'userInfoRevision',
    ],
  },
});
