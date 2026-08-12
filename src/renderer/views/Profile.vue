<script setup lang="ts">
defineOptions({ name: 'profile' });
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useUserStore } from '@/stores/user';
import { useLoginDeviceStore, type LoginDeviceSession } from '@/stores/loginDevices';
import Button from '@/components/ui/Button.vue';
import Dialog from '@/components/ui/Dialog.vue';
import Popover from '@/components/ui/Popover.vue';

import Avatar from '@/components/ui/Avatar.vue';

import logger from '@/utils/logger';
import {
  iconCheck,
  iconGift,
  iconHome,
  iconInfo,
  iconLogOut,
  iconRefreshCw,
  iconScan,
  iconSmartphone,
  iconTrash,
  iconUser,
} from '@/icons';
import PageScrollContainer from '@/components/ui/PageScrollContainer.vue';

interface VipLevelInfo {
  product_type?: string;
  is_vip?: number;
  vip_begin_time?: string | number;
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
const loginDeviceStore = useLoginDeviceStore();
const userInfo = computed(() => userStore.info);

const isLoading = ref(false);
const showDeviceManager = ref(false);
const showKickConfirm = ref(false);
const pendingKickDevice = ref<LoginDeviceSession | null>(null);

// 提取详细信息
const detail = computed<DetailState>(
  () => (userInfo.value?.extendsInfo?.detail as DetailState | undefined) || {},
);
const vipInfo = computed<VipInfoState>(
  () => (userInfo.value?.extendsInfo?.vip as VipInfoState | undefined) || {},
);
const busiVip = computed<VipLevelInfo[]>(() => vipInfo.value?.busi_vip || []);
const visitorCount = computed(() => {
  const value = detail.value.hvisitors ?? 0;
  const count = Number(value);
  return Number.isFinite(count) ? count : 0;
});

const tvip = computed(() => busiVip.value.find((v) => v.product_type === 'tvip' && v.is_vip === 1));
const svip = computed(() => busiVip.value.find((v) => v.product_type === 'svip' && v.is_vip === 1));

const gender = computed(() => {
  const g = detail.value?.gender;
  return g === 1 ? '男' : g === 0 ? '女' : '保密';
});

const location = computed(() => {
  const p = detail?.value?.province || '';
  const c = detail?.value?.city || '';
  if (p && c) {
    return `${p} - ${c}`;
  }
  if (p) {
    return p;
  }
  if (c) {
    return c;
  }
  return '-';
});

// 格式化逻辑
const formatLeLing = (rtime: any) => {
  if (!rtime) return '未知';
  const timestamp = Number.parseInt(String(rtime), 10);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '未知';
  const start = new Date(timestamp * 1000);
  const diff = Date.now() - start.getTime();
  if (diff < 0) return '未知';
  const days = Math.max(1, Math.floor(diff / (1000 * 60 * 60 * 24)));
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
    const totalMinutes = Math.floor(diff / (1000 * 60));
    const totalHours = Math.floor(diff / (1000 * 60 * 60));
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    if (days > 365) return `${Math.floor(days / 365)}年后到期`;
    if (days > 30) return `${Math.floor(days / 30)}个月后到期`;
    if (days > 0) return `${days}天后到期`;
    if (totalHours > 0) return `${totalHours}小时后到期`;
    if (totalMinutes > 0) return `${totalMinutes}分钟后到期`;
    return '即将到期';
  } catch {
    return null;
  }
};

// 格式化原始时间字符串为 yyyy-MM-dd HH:mm
const formatVipDate = (value?: string | number) => {
  if (!value) return '--';
  try {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
      d.getHours(),
    )}:${pad(d.getMinutes())}`;
  } catch {
    return String(value);
  }
};

const joinDeviceParts = (...parts: Array<string | number | undefined | null>) =>
  parts
    .map((part) => String(part ?? '').trim())
    .filter(Boolean)
    .join(', ');

const formatDeviceLoginType = (value?: string | number) => {
  const text = String(value ?? '').trim();
  if (text === '0') return '账号密码登录';
  if (text === '1') return '手机登录';
  if (text === '2') return '微信登录';
  if (text === '3') return 'QQ登录';
  if (text === '4') return '苹果登录';
  if (text === '5') return '微博登录';
  if (text === '6') return '扫码登录';
  return text ? `登录类型 ${text}` : '';
};

const formatDeviceLocation = (value?: string | number) => {
  const parts = String(value ?? '')
    .split(/[\s,，/]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.at(-1) || '';
};

const formatDeviceTime = (value?: string | number) => {
  const text = String(value ?? '').trim();
  if (!text || text === '0') return '';

  const numeric = Number(text);
  const date =
    Number.isFinite(numeric) && /^\d+$/.test(text)
      ? new Date(text.length <= 10 ? numeric * 1000 : numeric)
      : new Date(text);
  if (Number.isNaN(date.getTime())) return text;

  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
};

const formatDeviceDetailLine = (device: LoginDeviceSession) =>
  joinDeviceParts(formatDeviceLoginType(device.loginType), device.platform);

const formatDeviceActivityLine = (device: LoginDeviceSession) => {
  const time = formatDeviceTime(device.activeTime || device.loginTime);
  const location = formatDeviceLocation(device.location);
  return joinDeviceParts(time ? `${time}` : '', location);
};

const loginDevices = computed(() => loginDeviceStore.devices);
const loginDeviceSummary = computed(() => {
  if (loginDeviceStore.loading && !loginDeviceStore.loaded) return '正在同步登录设备';
  if (loginDeviceStore.error && loginDevices.value.length === 0) return loginDeviceStore.error;
  if (loginDevices.value.length === 0) return '暂无登录设备记录';
  return `当前账号已登录 ${loginDevices.value.length} 台设备`;
});

const loadData = async () => {
  if (!userStore.isLoggedIn) return;
  isLoading.value = true;
  try {
    await userStore.fetchUserInfo();
    // 并行刷新听歌等级信息（等级/积分），不阻塞主流程
    void userStore.fetchGradeInfo();
    void loginDeviceStore.fetchDevices();
  } catch (e) {
    logger.error('Profile', 'Load Data Error:', e);
  } finally {
    isLoading.value = false;
  }
};

const handleLogout = () => {
  showLogoutConfirm.value = true;
};

const confirmLogout = () => {
  showLogoutConfirm.value = false;
  loginDeviceStore.reset();
  userStore.logout();
  router.push('/main/home');
};

const openDeviceManager = async () => {
  showDeviceManager.value = true;
  if (!loginDeviceStore.loaded && !loginDeviceStore.loading) {
    await loginDeviceStore.fetchDevices();
  }
};

const refreshLoginDevices = async () => {
  await loginDeviceStore.fetchDevices();
};

const requestKickDevice = (device: LoginDeviceSession) => {
  if (!device.canKick) return;
  pendingKickDevice.value = device;
  showKickConfirm.value = true;
};

const confirmKickDevice = async () => {
  const device = pendingKickDevice.value;
  if (!device) return;
  const ok = await loginDeviceStore.kickDevice(device);
  if (ok) {
    showKickConfirm.value = false;
    pendingKickDevice.value = null;
  }
};

const showLogoutConfirm = ref(false);

onMounted(() => loadData());
</script>

<template>
  <PageScrollContainer class="profile-page-container">
    <div class="profile-page select-none bg-bg-main">
      <template v-if="userStore.isLoggedIn && userInfo">
        <div class="px-8 py-4">
          <div class="w-full">
            <!-- 1. Header -->
            <header class="flex items-center justify-between mb-6">
              <h1 class="text-[22px] font-black tracking-tight">个人中心</h1>
              <div class="flex items-center gap-2">
                <Button
                  variant="unstyled"
                  size="none"
                  @click="openDeviceManager"
                  class="w-10 h-10 flex items-center justify-center rounded-full border border-[var(--control-border)] text-text-main/70 hover:bg-[var(--control-hover-bg)] hover:text-text-main transition-all active:scale-90"
                  title="登录设备"
                  aria-label="登录设备"
                >
                  <Icon :icon="iconSmartphone" width="20" height="20" />
                </Button>
                <Button
                  variant="unstyled"
                  size="none"
                  @click="handleLogout"
                  class="w-10 h-10 flex items-center justify-center rounded-full border border-[var(--control-border)] hover:bg-red-500/10 hover:text-red-500 transition-all active:scale-90"
                  title="退出登录"
                  aria-label="退出登录"
                >
                  <Icon :icon="iconLogOut" width="20" height="20" />
                </Button>
              </div>
            </header>

            <!-- 2. User Profile Card -->
            <div
              class="user-card relative overflow-hidden p-6 rounded-3xl bg-linear-to-br from-primary/12 via-primary/6 to-transparent border border-primary/20 mb-6"
            >
              <div class="flex items-center gap-6 relative z-10">
                <div class="p-1 rounded-full border-2 border-primary/30 shrink-0">
                  <Avatar :src="userInfo.pic" class="w-19 h-19 rounded-full" />
                </div>
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-3 mb-2">
                    <h2 class="text-[20px] font-black truncate">{{ userInfo.nickname }}</h2>
                    <div
                      v-if="tvip"
                      class="px-1.5 py-0.5 rounded-md bg-linear-to-r from-[#07C160] to-[#07C160]/80 text-white text-[9px] font-black shadow-sm"
                    >
                      畅听
                    </div>
                    <div
                      v-if="svip"
                      class="px-1.5 py-0.5 rounded-md bg-linear-to-r from-orange-500 to-orange-500/80 text-white text-[9px] font-black shadow-sm"
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
                      <div class="w-px h-4 bg-[var(--border-subtle)]"></div>
                      <div class="flex flex-col">
                        <span class="text-[15px] font-black">{{ detail.follows || 0 }}</span>
                        <span class="text-[10px] opacity-60 uppercase font-bold tracking-wider"
                          >关注</span
                        >
                      </div>
                      <div class="w-px h-4 bg-[var(--border-subtle)]"></div>
                      <div class="flex flex-col">
                        <span class="text-[15px] font-black">{{ detail.fans || 0 }}</span>
                        <span class="text-[10px] opacity-60 uppercase font-bold tracking-wider"
                          >粉丝</span
                        >
                      </div>
                      <div class="w-px h-4 bg-[var(--border-subtle)]"></div>
                      <div class="flex flex-col">
                        <span class="text-[15px] font-black">{{ visitorCount }}</span>
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

            <div class="profile-info-grid grid gap-6">
              <!-- 3. Account Archives -->
              <div class="min-w-0">
                <div class="flex items-center gap-2 mb-4">
                  <Icon :icon="iconUser" width="16" height="16" class="text-primary" />
                  <h3 class="text-[16px] font-black">账号档案</h3>
                </div>
                <div
                  class="profile-archive-card space-y-0.5 p-2 rounded-[18px] bg-[var(--color-bg-elevated)] border border-[var(--border-subtle)] shadow-sm"
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
                    <span class="text-[13px] font-black">{{
                      formatDuration(detail.duration)
                    }}</span>
                  </div>
                  <div class="flex items-center justify-between px-4 py-3">
                    <span class="text-[13px] opacity-60 font-bold">所在地区</span>
                    <span class="text-[13px] font-black">{{ location }}</span>
                  </div>
                </div>
              </div>

              <!-- 4. Membership Status -->
              <div class="min-w-0">
                <div class="flex items-center gap-2 mb-4">
                  <Icon :icon="iconGift" width="16" height="16" class="text-primary" />
                  <h3 class="text-[16px] font-black">会员状态</h3>
                </div>
                <div class="space-y-2">
                  <!-- TVIP -->
                  <div
                    :class="[
                      'flex items-center gap-3 p-3 rounded-2xl border',
                      tvip
                        ? 'bg-green-500/10 border-green-500/20'
                        : 'bg-[var(--control-muted-bg)] border-transparent opacity-60',
                    ]"
                  >
                    <div
                      :class="[
                        'w-9 h-9 rounded-full flex items-center justify-center shrink-0',
                        tvip
                          ? 'bg-green-500/20 text-green-500'
                          : 'bg-[var(--control-hover-bg)] opacity-60',
                      ]"
                    >
                      <Icon :icon="iconHome" width="18" height="18" />
                    </div>
                    <div class="flex-1">
                      <h4 :class="['text-[13px] font-black', tvip ? 'text-green-500' : '']">
                        畅听会员
                      </h4>
                      <div v-if="tvip" @click.stop>
                        <Popover
                          trigger="hover"
                          side="top"
                          align="start"
                          :side-offset="6"
                          contentClass="vip-expire-popover"
                        >
                          <template #trigger>
                            <span
                              class="inline-flex items-center gap-1 text-[11px] opacity-60 font-bold uppercase cursor-pointer hover:opacity-100 transition-opacity"
                            >
                              {{ getVipExpireText(tvip) }}
                              <Icon :icon="iconInfo" width="14" height="14" class="opacity-70" />
                            </span>
                          </template>
                          <div class="min-w-45 space-y-1.5 text-[13px] normal-case">
                            <div class="flex items-center justify-between gap-3">
                              <span class="font-bold opacity-60">开始时间</span>
                              <span class="font-black">{{
                                formatVipDate(tvip.vip_begin_time)
                              }}</span>
                            </div>
                            <div class="flex items-center justify-between gap-3">
                              <span class="font-bold opacity-60">到期时间</span>
                              <span class="font-black text-green-500">{{
                                formatVipDate(tvip.vip_end_time)
                              }}</span>
                            </div>
                          </div>
                        </Popover>
                      </div>
                      <p v-else class="text-[11px] opacity-60 font-bold uppercase">未开通</p>
                    </div>
                    <div v-if="tvip" class="text-green-500">
                      <Icon :icon="iconCheck" width="16" height="16" />
                    </div>
                  </div>

                  <!-- SVIP -->
                  <div
                    :class="[
                      'flex items-center gap-3 p-3 rounded-2xl border',
                      svip
                        ? 'bg-orange-500/10 border-orange-500/20'
                        : 'bg-[var(--control-muted-bg)] border-transparent opacity-60',
                    ]"
                  >
                    <div
                      :class="[
                        'w-9 h-9 rounded-full flex items-center justify-center shrink-0',
                        svip
                          ? 'bg-orange-500/20 text-orange-500'
                          : 'bg-[var(--control-hover-bg)] opacity-60',
                      ]"
                    >
                      <Icon :icon="iconScan" width="18" height="18" />
                    </div>
                    <div class="flex-1">
                      <h4 :class="['text-[13px] font-black', svip ? 'text-orange-500' : '']">
                        概念会员
                      </h4>
                      <div v-if="svip" @click.stop>
                        <Popover
                          trigger="hover"
                          side="top"
                          align="start"
                          :side-offset="6"
                          contentClass="vip-expire-popover"
                        >
                          <template #trigger>
                            <span
                              class="inline-flex items-center gap-1 text-[11px] opacity-60 font-bold uppercase cursor-pointer hover:opacity-100 transition-opacity"
                            >
                              {{ getVipExpireText(svip) }}
                              <Icon :icon="iconInfo" width="14" height="14" class="opacity-70" />
                            </span>
                          </template>
                          <div class="min-w-45 space-y-1.5 text-[13px] normal-case">
                            <div class="flex items-center justify-between gap-3">
                              <span class="font-bold opacity-60">开始时间</span>
                              <span class="font-black">{{
                                formatVipDate(svip.vip_begin_time)
                              }}</span>
                            </div>
                            <div class="flex items-center justify-between gap-3">
                              <span class="font-bold opacity-60">到期时间</span>
                              <span class="font-black text-orange-500">{{
                                formatVipDate(svip.vip_end_time)
                              }}</span>
                            </div>
                          </div>
                        </Popover>
                      </div>
                      <p v-else class="text-[11px] opacity-60 font-bold uppercase">未开通</p>
                    </div>
                    <div v-if="svip" class="text-orange-500">
                      <Icon :icon="iconCheck" width="16" height="16" />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </template>
      <div v-else class="h-full flex flex-col items-center justify-center opacity-40 italic">
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

    <Dialog v-model:open="showLogoutConfirm" title="退出登录" description="确定要退出当前账号吗？">
      <template #footer>
        <Button variant="outline" size="sm" @click="showLogoutConfirm = false">取消</Button>
        <Button variant="danger" size="sm" @click="confirmLogout">确认退出</Button>
      </template>
    </Dialog>

    <Dialog
      v-model:open="showDeviceManager"
      title="登录设备管理"
      contentClass="login-device-dialog"
      :showClose="true"
    >
      <div class="space-y-4">
        <div class="flex items-center justify-between gap-3">
          <div>
            <p class="text-[13px] font-bold text-text-main">{{ loginDeviceSummary }}</p>
          </div>
          <Button
            variant="unstyled"
            size="none"
            class="w-8 h-8 rounded-full flex items-center justify-center text-text-main/70 hover:bg-[var(--control-hover-bg)] hover:text-text-main"
            title="刷新登录设备"
            aria-label="刷新登录设备"
            :disabled="loginDeviceStore.loading"
            @click="refreshLoginDevices"
          >
            <Icon
              :icon="iconRefreshCw"
              width="15"
              height="15"
              :class="loginDeviceStore.loading ? 'animate-spin' : ''"
            />
          </Button>
        </div>

        <div v-if="loginDeviceStore.error" class="text-[12px] font-bold text-red-500">
          {{ loginDeviceStore.error }}
        </div>

        <div
          v-if="loginDeviceStore.loading && loginDevices.length === 0"
          class="py-10 text-center text-[13px] opacity-50 font-bold"
        >
          正在获取登录设备
        </div>
        <div
          v-else-if="loginDevices.length === 0"
          class="py-10 text-center text-[13px] opacity-50 font-bold"
        >
          暂无登录设备记录
        </div>
        <div v-else class="space-y-2">
          <div
            v-for="device in loginDevices"
            :key="device.id"
            class="login-device-row flex items-center gap-3 p-3 rounded-2xl border border-[var(--border-subtle)] bg-[var(--control-muted-bg)]"
          >
            <div
              :class="[
                'w-10 h-10 rounded-xl flex items-center justify-center shrink-0',
                device.isCurrent ? 'bg-primary/15 text-primary' : 'bg-[var(--control-hover-bg)]',
              ]"
            >
              <Icon :icon="iconSmartphone" width="20" height="20" />
            </div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 min-w-0">
                <span class="text-[13px] font-black truncate">{{ device.title }}</span>
                <span
                  v-if="device.isCurrent"
                  class="px-1.5 py-0.5 rounded-md bg-primary/12 text-primary text-[10px] font-black shrink-0"
                  >本机</span
                >
                <span
                  v-if="device.isNew && !device.isCurrent"
                  class="px-1.5 py-0.5 rounded-md bg-green-500/12 text-green-500 text-[10px] font-black shrink-0"
                  >新设备</span
                >
              </div>
              <p class="text-[11px] opacity-60 font-bold truncate">
                {{ formatDeviceDetailLine(device) }}
              </p>
              <p class="text-[11px] opacity-45 font-bold truncate">
                {{ formatDeviceActivityLine(device) }}
              </p>
            </div>
            <Button
              v-if="!device.isCurrent"
              variant="danger"
              size="xs"
              :disabled="!device.canKick"
              :loading="loginDeviceStore.kickingId === device.id"
              class="shrink-0"
              @click="requestKickDevice(device)"
            >
              <Icon
                v-if="loginDeviceStore.kickingId !== device.id"
                :icon="iconTrash"
                width="13"
                height="13"
              />
              <span class="ml-1">移除</span>
            </Button>
          </div>
        </div>
      </div>
    </Dialog>

    <Dialog
      v-model:open="showKickConfirm"
      title="移除登录设备"
      :description="`移除“${pendingKickDevice?.title || '该设备'}”后，该设备需要重新登录。`"
    >
      <template #footer>
        <Button variant="outline" size="sm" @click="showKickConfirm = false">取消</Button>
        <Button
          variant="danger"
          size="sm"
          :loading="
            Boolean(pendingKickDevice && loginDeviceStore.kickingId === pendingKickDevice.id)
          "
          @click="confirmKickDevice"
        >
          确认移除
        </Button>
      </template>
    </Dialog>
  </PageScrollContainer>
</template>

<style scoped>
.user-card {
  box-shadow: 0 20px 60px -10px rgba(var(--color-primary-rgb), 0.15);
}

.profile-archive-card {
  background-color: var(--color-bg-elevated) !important;
  border-color: var(--border-subtle) !important;
  box-shadow: var(--shadow-elevated) !important;
}

.login-device-row {
  min-height: 76px;
}

.profile-info-grid {
  display: grid;
  gap: 24px;
  grid-template-columns: minmax(0, 1fr);
}

@media (min-width: 768px) {
  .profile-info-grid {
    grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
  }
}
</style>

<style>
.vip-expire-popover.echo-popover-content {
  padding: 12px 14px;
  border-radius: 14px;
  background: var(--color-bg-elevated);
  border-color: var(--border-subtle);
}

.dialog-content.login-device-dialog {
  width: min(560px, 92vw);
  max-height: min(720px, calc(100vh - 140px));
}
</style>
