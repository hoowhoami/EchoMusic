<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useUserStore } from '@/stores/user';
import { useSettingStore } from '@/stores/setting';
import Button from '@/components/ui/Button.vue';

import { claimDayVip, upgradeDayVip, getVipMonthRecord } from '@/api/user';
import Avatar from '@/components/ui/Avatar.vue';
import logger from '@/utils/logger';
import {
  iconLogOut,
  iconUser,
  iconGift,
  iconHome,
  iconScan,
  iconCheck,
  iconChevronRight,
} from '@/icons';

interface VipActionResponse {
  status?: number;
  error_code?: number;
}

interface VipLevelInfo {
  product_type?: string;
  is_vip?: number;
  vip_end_time?: string | number;
}

interface VipInfoState {
  busi_vip?: VipLevelInfo[];
  [key: string]: unknown;
}

interface DetailState {
  gender?: number;
  [key: string]: unknown;
}

const router = useRouter();
const userStore = useUserStore();
const settingStore = useSettingStore();
const userInfo = computed(() => userStore.info);

const isLoading = ref(false);

// 提取详细信息
const detail = computed<DetailState>(
  () => (userInfo.value?.extendsInfo?.detail as DetailState | undefined) || {},
);
const vipInfo = computed<VipInfoState>(
  () => (userInfo.value?.extendsInfo?.vip as VipInfoState | undefined) || {},
);
const busiVip = computed<VipLevelInfo[]>(() => vipInfo.value?.busi_vip || []);

const tvip = computed(() => busiVip.value.find((v) => v.product_type === 'tvip' && v.is_vip === 1));
const svip = computed(() => busiVip.value.find((v) => v.product_type === 'svip' && v.is_vip === 1));

const gender = computed(() => {
  const g = detail.value?.gender;
  return g === 1 ? '男' : g === 0 ? '女' : '保密';
});

// 格式化逻辑
const formatLeLing = (rtime: any) => {
  if (!rtime) return '未知';
  const start = new Date(parseInt(rtime) * 1000);
  const diff = Date.now() - start.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days > 365) return `${Math.floor(days / 365)} 年`;
  if (days > 30) return `${Math.floor(days / 30)} 个月`;
  return `${days} 天`;
};

const formatDuration = (minutes: any) => {
  if (!minutes) return '0 小时';
  const m = parseInt(minutes) || 0;
  if (m > 60) return `${Math.floor(m / 60)} 小时 ${m % 60} 分钟`;
  return `${m} 分钟`;
};

const getVipExpireText = (vipData: any) => {
  if (!vipData?.vip_end_time) return null;
  try {
    const expireDate = new Date(vipData.vip_end_time);
    const now = new Date();
    const diff = expireDate.getTime() - now.getTime();
    if (diff < 0) return '已过期';
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    if (days > 365) return `${Math.floor(days / 365)}年后到期`;
    if (days > 30) return `${Math.floor(days / 30)}个月后到期`;
    if (days > 0) return `${days}天后到期`;
    return '即将到期';
  } catch {
    return null;
  }
};

const loadData = async () => {
  if (!userStore.isLoggedIn) return;
  isLoading.value = true;
  try {
    await userStore.fetchUserInfo();

    const recordRes = await getVipMonthRecord();
    const today = new Date().toISOString().split('T')[0];
    const recordList = recordRes?.data?.list || [];
    const isTvipClaimed = recordList.some((item: any) => item.day === today);
    const isSvipActive = !!svip.value;

    userStore.setClaimStatus(isTvipClaimed, isSvipActive);
  } catch (e) {
    logger.error('Profile', 'Load Data Error:', e);
  } finally {
    isLoading.value = false;
  }

  // 如果开启了自动领取 VIP，尝试领取一次
  if (settingStore.autoReceiveVip && userStore.isLoggedIn) {
    try {
      await userStore.autoReceiveVipIfNeeded();
    } catch (e) {
      logger.warn('Profile', 'Auto receive VIP skipped:', e);
    }
  }
};

const handleClaimTvip = async () => {
  if (userStore.isTvipClaimedToday) return;
  isLoading.value = true;
  try {
    const today = await userStore.getServerToday();
    const res = (await claimDayVip(today)) as VipActionResponse;
    if (res.status === 1) {
      userStore.setClaimStatus(true, userStore.isSvipClaimedToday);
      await loadData();
    }
  } catch (e) {
    logger.error('Profile', 'Claim TVIP error:', e);
  } finally {
    isLoading.value = false;
  }
};

const handleUpgradeSvip = async () => {
  if (userStore.isSvipClaimedToday || !userStore.isTvipClaimedToday) return;
  isLoading.value = true;
  try {
    const res = (await upgradeDayVip()) as VipActionResponse;
    if (res.status === 1 || res.error_code === 297002) {
      userStore.setClaimStatus(userStore.isTvipClaimedToday, true);
      await loadData(); // 刷新
    }
  } catch (e) {
    logger.error('Profile', 'Upgrade SVIP error:', e);
  } finally {
    isLoading.value = false;
  }
};

const handleLogout = () => {
  userStore.logout();
  router.push('/main/home');
};

onMounted(() => loadData());
</script>

<template>
  <div
    class="profile-page select-none bg-bg-main"
  >
    <template v-if="userStore.isLoggedIn && userInfo">
      <div class="px-8 py-5">
        <div class="w-full animate-in slide-in-from-bottom-4 duration-500">
          <!-- 1. Header -->
          <header class="flex items-center justify-between mb-6">
            <h1 class="text-[24px] font-black tracking-tight">个人中心</h1>
            <Button
              variant="unstyled"
              size="none"
              @click="handleLogout"
              class="w-10 h-10 flex items-center justify-center rounded-full border border-border-light hover:bg-red-500/10 hover:text-red-500 transition-all active:scale-90"
              title="退出登录"
            >
              <Icon :icon="iconLogOut" width="20" height="20" />
            </Button>
          </header>

          <!-- 2. User Profile Card -->
          <div
            class="user-card relative overflow-hidden p-6 rounded-[24px] bg-gradient-to-br from-primary/12 via-primary/6 to-transparent border border-primary/20 mb-6"
          >
            <div class="flex items-center gap-6 relative z-10">
              <div class="p-1 rounded-full border-2 border-primary/30 shrink-0">
                <Avatar :src="userInfo.pic" class="w-[76px] h-[76px] rounded-full" />
              </div>
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-3 mb-2">
                  <h2 class="text-[20px] font-black truncate">{{ userInfo.nickname }}</h2>
                  <div
                    v-if="tvip"
                    class="px-1.5 py-0.5 rounded-md bg-gradient-to-r from-[#07C160] to-[#07C160]/80 text-white text-[9px] font-black shadow-sm"
                  >
                    畅听
                  </div>
                  <div
                    v-if="svip"
                    class="px-1.5 py-0.5 rounded-md bg-gradient-to-r from-orange-500 to-orange-500/80 text-white text-[9px] font-black shadow-sm"
                  >
                    概念
                  </div>
                </div>
                <div class="flex flex-col">
                  <p
                    v-if="detail.descri"
                    class="text-[12px] opacity-70 font-medium line-clamp-2 mb-3"
                  >
                    {{ detail.descri }}
                  </p>

                  <div class="flex items-center gap-6">
                    <div class="flex flex-col">
                      <span class="text-[15px] font-black">Lv.{{ detail.p_grade || 0 }}</span>
                      <span class="text-[10px] opacity-60 uppercase font-bold tracking-wider"
                        >等级</span
                      >
                    </div>
                    <div class="w-[1px] h-4 bg-black/5 dark:bg-white/5"></div>
                    <div class="flex flex-col">
                      <span class="text-[15px] font-black">{{ detail.follows || 0 }}</span>
                      <span class="text-[10px] opacity-60 uppercase font-bold tracking-wider"
                        >关注</span
                      >
                    </div>
                    <div class="w-[1px] h-4 bg-black/5 dark:bg-white/5"></div>
                    <div class="flex flex-col">
                      <span class="text-[15px] font-black">{{ detail.fans || 0 }}</span>
                      <span class="text-[10px] opacity-60 uppercase font-bold tracking-wider"
                        >粉丝</span
                      >
                    </div>
                    <div class="w-[1px] h-4 bg-black/5 dark:bg-white/5"></div>
                    <div class="flex flex-col">
                      <span class="text-[15px] font-black">{{ detail.nvisitors || 0 }}</span>
                      <span class="text-[10px] opacity-60 uppercase font-bold tracking-wider"
                        >访客</span
                      >
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <!-- 装饰背景 -->
            <div
              class="absolute -right-10 -bottom-10 w-40 h-40 bg-primary/5 rounded-full blur-3xl pointer-events-none"
            ></div>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-5 gap-6">
            <!-- 3. Account Archives -->
            <div class="md:col-span-3">
              <div class="flex items-center gap-2 mb-4">
                <Icon :icon="iconUser" width="16" height="16" class="text-primary" />
                <h3 class="text-[16px] font-black">账号档案</h3>
              </div>
              <div
                class="profile-archive-card space-y-0.5 p-2 rounded-[18px] bg-white border border-black/10 shadow-sm dark:bg-white/[0.04] dark:border-white/10 dark:shadow-none"
              >
                <div class="flex items-center justify-between px-4 py-3">
                  <span class="text-[13px] opacity-60 font-bold">用户 ID</span>
                  <span class="text-[13px] font-black">{{ userInfo.userid }}</span>
                </div>
                <div class="flex items-center justify-between px-4 py-3">
                  <span class="text-[13px] opacity-60 font-bold">性别</span>
                  <span class="text-[13px] font-black">{{ gender }}</span>
                </div>
                <div class="flex items-center justify-between px-4 py-3">
                  <span class="text-[13px] opacity-60 font-bold">乐龄</span>
                  <span class="text-[13px] font-black">{{ formatLeLing(detail.rtime) }}</span>
                </div>
                <div class="flex items-center justify-between px-4 py-3">
                  <span class="text-[13px] opacity-60 font-bold">累计听歌</span>
                  <span class="text-[13px] font-black">{{ formatDuration(detail.duration) }}</span>
                </div>
                <div class="flex items-center justify-between px-4 py-3">
                  <span class="text-[13px] opacity-60 font-bold">所在地区</span>
                  <span class="text-[13px] font-black">{{ detail.city || '-' }}</span>
                </div>
              </div>
            </div>

            <!-- 4. Daily Benefits -->
            <div class="md:col-span-2">
              <div class="flex items-center gap-2 mb-4">
                <Icon :icon="iconGift" width="16" height="16" class="text-primary" />
                <h3 class="text-[16px] font-black">每日权益</h3>
              </div>
              <div class="space-y-2">
                <!-- TVIP -->
                <div
                  @click="handleClaimTvip"
                  :class="[
                    'flex items-center gap-3 p-3 rounded-[16px] transition-all border',
                    userStore.isTvipClaimedToday
                      ? 'bg-green-500/10 border-green-500/20'
                      : 'bg-black/[0.03] dark:bg-white/[0.03] border-transparent hover:bg-black/[0.06] dark:hover:bg-white/[0.06] cursor-pointer',
                  ]"
                >
                  <div
                    :class="[
                      'w-9 h-9 rounded-full flex items-center justify-center shrink-0',
                      userStore.isTvipClaimedToday
                        ? 'bg-green-500/20 text-green-500'
                        : 'bg-black/5 dark:bg-white/5 opacity-60',
                    ]"
                  >
                    <Icon :icon="iconHome" width="18" height="18" />
                  </div>
                  <div class="flex-1">
                    <h4
                      :class="[
                        'text-[13px] font-black',
                        userStore.isTvipClaimedToday ? 'text-green-500' : '',
                      ]"
                    >
                      领取畅听会员
                    </h4>
                    <p v-if="tvip" class="text-[10px] opacity-60 font-bold uppercase">
                      {{ getVipExpireText(tvip) }}
                    </p>
                  </div>
                  <div v-if="userStore.isTvipClaimedToday" class="text-green-500">
                    <Icon :icon="iconCheck" width="16" height="16" />
                  </div>
                  <div v-else class="opacity-40">
                    <Icon :icon="iconChevronRight" width="12" height="12" />
                  </div>
                </div>

                <!-- SVIP -->
                <div
                  @click="handleUpgradeSvip"
                  :class="[
                    'flex items-center gap-3 p-3 rounded-[16px] transition-all border',
                    userStore.isSvipClaimedToday || svip
                      ? 'bg-orange-500/10 border-orange-500/20'
                      : userStore.isTvipClaimedToday
                        ? 'bg-black/[0.03] dark:bg-white/[0.03] border-transparent hover:bg-black/[0.06] dark:hover:bg-white/[0.06] cursor-pointer'
                        : 'bg-black/[0.01] dark:bg-white/[0.01] opacity-60 cursor-not-allowed',
                  ]"
                >
                  <div
                    :class="[
                      'w-9 h-9 rounded-full flex items-center justify-center shrink-0',
                      userStore.isSvipClaimedToday || svip
                        ? 'bg-orange-500/20 text-orange-500'
                        : 'bg-black/5 dark:bg-white/5 opacity-60',
                    ]"
                  >
                    <Icon :icon="iconScan" width="18" height="18" />
                  </div>
                  <div class="flex-1">
                    <h4
                      :class="[
                        'text-[13px] font-black',
                        userStore.isSvipClaimedToday || svip ? 'text-orange-500' : '',
                      ]"
                    >
                      升级概念会员
                    </h4>
                    <p v-if="svip" class="text-[10px] opacity-60 font-bold uppercase">
                      {{ getVipExpireText(svip) }}
                    </p>
                  </div>
                  <div v-if="userStore.isSvipClaimedToday || svip" class="text-orange-500">
                    <Icon :icon="iconCheck" width="16" height="16" />
                  </div>
                  <div v-else class="opacity-40">
                    <Icon :icon="iconChevronRight" width="12" height="12" />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </template>
    <div
      v-else
      class="h-full flex flex-col items-center justify-center opacity-40 italic animate-in fade-in duration-500"
    >
      <Icon :icon="iconUser" width="64" height="64" class="mb-4" />
      <span class="text-[16px] font-bold">请先登录以查看个人中心</span>
      <Button
        variant="primary"
        size="sm"
        @click="router.push('/login')"
        class="mt-6 rounded-full not-italic"
        >立即登录</Button
      >
    </div>
  </div>
</template>

<style scoped>
.user-card {
  box-shadow: 0 20px 60px -10px rgba(var(--color-primary-rgb), 0.15);
}

.profile-archive-card {
  background-color: #ffffff !important;
  border-color: rgba(0, 0, 0, 0.12) !important;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.06) !important;
}

.dark .profile-archive-card {
  background-color: rgba(255, 255, 255, 0.04) !important;
  border-color: rgba(255, 255, 255, 0.1) !important;
  box-shadow: none !important;
}
</style>
