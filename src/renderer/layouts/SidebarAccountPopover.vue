<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Icon } from '@iconify/vue';
import { iconChevronDown, iconChevronRight } from '@/icons';
import Avatar from '@/components/ui/Avatar.vue';
import Button from '@/components/ui/Button.vue';
import LogoutConfirmDialog from '@/components/profile/LogoutConfirmDialog.vue';
import Popover from '@/components/ui/Popover.vue';
import { useUserStore } from '@/stores/user';
import { useLoginDeviceStore } from '@/stores/loginDevices';
import { formatListeningDuration, getGradeProgress } from '../../shared/profileStats';

const user = useUserStore();
const devices = useLoginDeviceStore();
const router = useRouter();
const route = useRoute();
const open = ref(false);
const confirmLogout = ref(false);
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
  const entries = user.info?.extendsInfo?.vip?.busi_vip;
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
    .filter((entry) => entry.is_vip === 1 && ['tvip', 'svip'].includes(String(entry.product_type)))
    .map((entry) => ({
      type: String(entry.product_type),
      label: entry.product_type === 'svip' ? '概念会员' : '畅听会员',
      expires: formatExpiry(entry.vip_end_time),
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
const logout = () => {
  confirmLogout.value = false;
  devices.reset();
  user.logout();
  void router.push('/main/home');
};
</script>

<template>
  <Popover
    v-model:open="open"
    trigger="click"
    side="bottom"
    align="end"
    :side-offset="14"
    :content-style="{ width: '340px', maxWidth: 'calc(100vw - 24px)', padding: '0' }"
  >
    <template #trigger>
      <button
        type="button"
        class="account-trigger"
        aria-label="个人信息"
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
            <strong>{{ user.info.nickname }}</strong>
            <span>ID · {{ user.info.userid }}</span>
          </div>
        </header>
        <p v-if="signature" class="account-signature">{{ signature }}</p>
        <dl v-if="stats.length" class="account-stats">
          <div v-for="stat in stats" :key="stat.label">
            <dd>{{ stat.value }}</dd>
            <dt>{{ stat.label }}</dt>
          </div>
        </dl>
        <section
          v-if="grade.grade !== null || detail.d_sec != null || detail.duration != null"
          class="account-grade"
        >
          <div class="account-row">
            <span>听歌等级</span><strong v-if="grade.grade !== null">Lv.{{ grade.grade }}</strong>
          </div>
          <template v-if="grade.available">
            <div
              class="account-progress"
              role="progressbar"
              aria-label="等级经验进度"
              :aria-valuenow="grade.percent"
              :aria-valuemin="0"
              :aria-valuemax="100"
            >
              <span :style="{ width: `${grade.percent}%` }" />
            </div>
            <p class="account-caption">
              距 Lv.{{ grade.nextGrade }} 还差 {{ grade.remaining?.toLocaleString() }} 经验
            </p>
          </template>
          <div
            v-if="detail.d_sec != null || detail.duration != null"
            class="account-row account-listening"
          >
            <span>累计听歌</span><span>{{ duration }}</span>
          </div>
        </section>
        <div v-if="memberships.length" class="account-memberships">
          <div
            v-for="membership in memberships"
            :key="membership.type"
            class="account-row account-membership"
          >
            <strong>{{ membership.label }}</strong
            ><span>{{ membership.expires }}</span>
          </div>
        </div>
        <footer class="account-actions">
          <button type="button" @click="navigate('/main/profile')">
            个人主页<Icon :icon="iconChevronRight" :width="14" />
          </button>
          <button type="button" @click="requestLogout">退出登录</button>
        </footer>
      </template>
      <div v-else class="account-login">
        <Avatar :size="48" class="rounded-full" />
        <strong>登录 EchoMusic</strong>
        <span>查看个人资料，同步你的音乐收藏</span>
        <Button @click="navigate('/login')">登录账号</Button>
      </div>
    </section>
  </Popover>
  <LogoutConfirmDialog v-model:open="confirmLogout" @confirm="logout" />
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
.account-trigger svg {
  transition: transform 0.18s ease;
}
.account-trigger .is-open {
  transform: rotate(180deg);
}
.account-panel {
  padding: 22px;
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
.account-name strong {
  font-size: 16px;
  overflow-wrap: anywhere;
}
.account-name span,
.account-caption,
.account-signature {
  font-size: 12px;
  color: var(--color-text-secondary);
}
.account-signature {
  margin: 14px 0 0;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.account-stats {
  display: flex;
  gap: 8px;
  margin: 20px 0 0;
}
.account-stats > div {
  flex: 1;
  min-width: 0;
  padding: 12px 4px;
  border-radius: 8px;
  background: var(--control-muted-bg);
  text-align: center;
}
.account-stats dd {
  font-size: 22px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  margin: 0;
  overflow-wrap: anywhere;
}
.account-stats dt {
  font-size: 12px;
  color: var(--color-text-secondary);
  margin-top: 4px;
}
.account-grade {
  margin-top: 20px;
  padding: 16px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--color-primary) 8%, var(--control-muted-bg));
}
.account-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  font-size: 13px;
}
.account-grade strong {
  font-size: 20px;
  color: var(--color-primary-text);
}
.account-progress {
  margin-top: 14px;
  height: 4px;
  overflow: hidden;
  border-radius: 2px;
  background: var(--control-hover-bg);
}
.account-progress span {
  display: block;
  height: 100%;
  background: var(--color-primary);
  border-radius: inherit;
}
.account-caption {
  margin: 8px 0 0;
}
.account-listening {
  margin-top: 14px;
  font-size: 12px;
}
.account-listening > :first-child {
  color: var(--color-text-secondary);
}
.account-memberships {
  display: grid;
  gap: 10px;
  margin-top: 16px;
}
.account-membership {
  padding: 12px 0;
  border-bottom: 1px solid var(--border-subtle);
}
.account-membership span {
  font-size: 12px;
  color: var(--color-text-secondary);
}
.account-actions {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-top: 18px;
}
.account-actions button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 6px 0;
  cursor: pointer;
  font-size: 13px;
}
.account-actions button:hover {
  color: var(--color-primary-text);
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
</style>
