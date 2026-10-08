<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Icon } from '@iconify/vue';
import { iconChevronDown, iconChevronRight } from '@/icons';
import Avatar from '@/components/ui/Avatar.vue';
import RollingNumber from '@/components/ui/RollingNumber.vue';
import Button from '@/components/ui/Button.vue';
import LogoutConfirmDialog from '@/components/profile/LogoutConfirmDialog.vue';
import AccountSwitcherDialog from '@/components/profile/AccountSwitcherDialog.vue';
import Popover from '@/components/ui/Popover.vue';
import { useUserStore } from '@/stores/user';
import { useLoginDeviceStore } from '@/stores/loginDevices';
import { getAccountVipStatus } from '@/utils/accountVip';
import { formatListeningDuration, getGradeProgress } from '../../shared/profileStats';

defineProps<{ compact?: boolean }>();

const user = useUserStore();
const devices = useLoginDeviceStore();
const router = useRouter();
const route = useRoute();
const open = ref(false);
const confirmLogout = ref(false);
const accountSwitcherOpen = ref(false);
const detail = computed(() => user.info?.extendsInfo?.detail ?? {});
const grade = computed(() => getGradeProgress(detail.value));
const duration = computed(() => formatListeningDuration(detail.value.d_sec, detail.value.duration));
const signature = computed(() =>
  typeof detail.value.descri === 'string' ? detail.value.descri.trim() : '',
);
const stats = computed(() =>
  [
    { label: '好友', value: detail.value.friends ?? detail.value.friend_count },
    { label: '关注', value: detail.value.follows ?? detail.value.follow_count },
    { label: '粉丝', value: detail.value.fans },
  ]
    .filter(
      (item) =>
        item.value !== undefined &&
        item.value !== null &&
        item.value !== '' &&
        Number.isFinite(Number(item.value)) &&
        Number(item.value) >= 0,
    )
    .map((item) => ({ label: item.label, value: Number(item.value).toLocaleString() })),
);
const memberships = computed(() => {
  const info = user.info?.extendsInfo?.vip ?? {};
  const status = getAccountVipStatus(info);
  return [
    { type: 'suvip', label: '超级VIP', active: status.superVip, endTime: info.su_vip_end_time },
    { type: 'dvip', label: '豪华VIP', active: status.deluxeVip, endTime: info.vip_end_time },
    {
      type: 'svip',
      label: '概念会员',
      active: !!status.conceptVip,
      endTime: status.conceptVip?.vip_end_time,
    },
    {
      type: 'tvip',
      label: '畅听会员',
      active: !!status.musicVip,
      endTime: status.musicVip?.vip_end_time,
    },
  ]
    .filter((entry) => entry.active)
    .map((entry) => ({
      type: entry.type,
      label: entry.label,
      expires: formatExpiry(entry.endTime) || '已开通',
    }));
});
function formatExpiry(value: unknown) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} 到期`;
}
watch(open, (value) => {
  if (!value || !user.isLoggedIn) return;
  void user.fetchUserInfoOnce();
  void user.fetchGradeInfo();
});
watch(
  () => [user.accountRevision, route.fullPath],
  () => {
    open.value = false;
    confirmLogout.value = false;
    accountSwitcherOpen.value = false;
  },
);
const navigate = (path: string) => {
  open.value = false;
  void router.push(path);
};
const requestLogout = () => {
  open.value = false;
  confirmLogout.value = true;
};
const requestAccountSwitch = () => {
  open.value = false;
  accountSwitcherOpen.value = true;
};
const logout = () => {
  confirmLogout.value = false;
  devices.reset();
  user.logout();
  void router.push('/main');
};
</script>

<template>
  <Popover
    v-model:open="open"
    trigger="click"
    side="bottom"
    align="end"
    :show-arrow="false"
    :side-offset="14"
    :content-style="{ width: '320px', maxWidth: 'calc(100vw - 24px)', padding: '0' }"
  >
    <template #trigger>
      <button
        type="button"
        class="action-icon account-trigger"
        :class="{ 'account-trigger-compact': compact }"
        aria-label="个人信息与账号切换"
        aria-haspopup="dialog"
        :aria-expanded="open"
      >
        <Icon :icon="iconChevronDown" :width="18" :height="18" :class="{ 'is-open': open }" />
      </button>
    </template>
    <section class="account-panel" aria-label="账号信息">
      <template v-if="user.isLoggedIn && user.info">
        <header class="account-identity">
          <Avatar :src="user.info.pic" :size="44" class="rounded-full" />
          <div class="account-name">
            <div class="account-name-line">
              <strong>{{ user.info.nickname }}</strong
              ><span v-if="grade.grade !== null" class="account-level">Lv.{{ grade.grade }}</span>
            </div>
            <span>ID · {{ user.info.userid }}</span>
          </div>
        </header>
        <p v-if="signature" class="account-signature">{{ signature }}</p>
        <dl v-if="stats.length" class="account-stats">
          <div v-for="stat in stats" :key="stat.label">
            <dd><RollingNumber :value="stat.value" /></dd>
            <dt>{{ stat.label }}</dt>
          </div>
        </dl>
        <div
          v-if="detail.d_sec != null || detail.duration != null"
          class="account-row account-listening"
        >
          <span>累计听歌</span><span>{{ duration }}</span>
        </div>
        <div v-if="memberships.length" class="account-memberships">
          <div v-for="membership in memberships" :key="membership.type" class="account-membership">
            <span class="account-membership-marker" aria-hidden="true"></span>
            <div>
              <strong>{{ membership.label }}</strong
              ><span>{{ membership.expires }}</span>
            </div>
          </div>
        </div>
        <footer class="account-actions">
          <Button
            variant="secondary"
            size="none"
            class="account-action"
            @click="navigate('/main/profile')"
          >
            个人主页<Icon :icon="iconChevronRight" :width="14" />
          </Button>
          <Button
            variant="secondary"
            size="none"
            class="account-action"
            @click="requestAccountSwitch"
            >切换账号</Button
          >
          <Button variant="secondary" size="none" class="account-action" @click="requestLogout"
            >退出登录</Button
          >
        </footer>
      </template>
      <div v-else class="account-login">
        <Avatar :size="48" class="rounded-full" />
        <strong>登录 EchoMusic</strong>
        <span>查看个人资料，同步你的音乐收藏</span>
        <Button @click="navigate('/login')">登录账号</Button>
        <Button v-if="user.savedAccounts.length" variant="ghost" @click="requestAccountSwitch"
          >切换账号</Button
        >
      </div>
    </section>
  </Popover>
  <LogoutConfirmDialog v-model:open="confirmLogout" @confirm="logout" />
  <AccountSwitcherDialog v-model:open="accountSwitcherOpen" />
</template>

<style scoped>
.account-trigger {
  display: grid;
  place-items: center;
  flex: none;
  width: 28px;
  height: 44px;
  color: var(--icon-main);
  cursor: pointer;
}
.account-trigger:hover {
  color: var(--color-text-main);
}
.account-trigger-compact {
  width: 18px;
  height: 42px;
}
.account-trigger svg {
  transition: transform var(--motion-duration-fast) var(--motion-ease-standard);
}
.account-trigger .is-open {
  transform: rotate(180deg);
}
.account-panel {
  padding: 18px;
  max-height: min(620px, calc(100vh - 150px));
  overflow-y: auto;
  color: var(--color-text-main);
}
.account-identity {
  display: flex;
  gap: 12px;
  align-items: center;
}
.account-name {
  display: grid;
  gap: 4px;
  min-width: 0;
}
.account-name-line {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  align-items: baseline;
}
.account-level {
  font-size: 11px;
  font-weight: 500;
  color: var(--color-text-secondary);
}
.account-name strong {
  font-size: 16px;
  font-weight: 600;
  overflow-wrap: anywhere;
  line-height: 1.4;
}
.account-name > span,
.account-signature {
  font-size: 12px;
  color: var(--color-text-secondary);
}
.account-signature {
  margin: 12px 0 0;
  line-height: 1.6;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.account-stats {
  display: flex;
  margin: 18px 0;
  padding: 14px 0;
  border-top: 1px solid var(--border-subtle);
  border-bottom: 1px solid var(--border-subtle);
}
.account-stats > div {
  flex: 1;
  min-width: 0;
  padding: 0 6px;
  text-align: center;
}
.account-stats > div + div {
  border-left: 1px solid var(--border-subtle);
}
.account-stats dd {
  font-size: 20px;
  font-weight: 600;
  line-height: 1.3;
  font-variant-numeric: tabular-nums;
  margin: 0;
  overflow-wrap: anywhere;
}
.account-stats dt {
  font-size: 11px;
  color: var(--color-text-secondary);
  margin-top: 4px;
}
.account-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  font-size: 13px;
}
.account-listening {
  margin-top: 16px;
  font-size: 12px;
  align-items: baseline;
}
.account-listening > :first-child {
  flex: none;
  color: var(--color-text-secondary);
}
.account-listening > :last-child {
  text-align: right;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.account-memberships {
  display: grid;
  gap: 12px;
  margin-top: 18px;
}
.account-membership {
  display: flex;
  align-items: center;
  gap: 10px;
}
.account-membership-marker {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-primary);
}
.account-membership > div {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: baseline;
  gap: 4px 12px;
  flex: 1;
  min-width: 0;
}
.account-membership strong {
  font-size: 12px;
  font-weight: 500;
}
.account-membership div > span {
  font-size: 11px;
  color: var(--color-text-secondary);
}
.account-actions {
  display: flex;
  gap: 10px;
  margin-top: 20px;
}
.account-action {
  flex: 1;
  display: inline-flex;
  justify-content: center;
  align-items: center;
  gap: 5px;
  height: 34px;
  padding: 0 10px;
  border-radius: var(--radius-control);
  font-size: 12px;
  font-weight: 500;
}
.account-login {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 12px 0;
}
.account-login span {
  font-size: 12px;
  color: var(--color-text-secondary);
}
@media (prefers-reduced-motion: reduce) {
  .account-trigger svg {
    transition: none;
  }
}
</style>
