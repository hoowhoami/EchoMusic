<script setup lang="ts">
import { watchUserSession } from '@/utils/watchUserSession';

import { userSessionSources } from '@/utils/userSession';

import { computed, nextTick, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import Avatar from '@/components/ui/Avatar.vue';
import Badge from '@/components/ui/Badge.vue';
import Button from '@/components/ui/Button.vue';
import Dialog from '@/components/ui/Dialog.vue';
import Tag from '@/components/ui/Tag.vue';
import { useUserStore, type SavedAccount } from '@/stores/user';
import { useToastStore } from '@/stores/toast';
import { getUserGradeInfo } from '@/api/user';
import { getListeningSeconds } from '../../../shared/profileStats';

const open = defineModel<boolean>('open', { default: false });
const user = useUserStore();
const toast = useToastStore();
const router = useRouter();
const managing = ref(false);
const removal = ref<SavedAccount | null>(null);
const durations = ref<Record<number, number>>({});
const loadingDurations = ref(new Set<number>());
const currentId = computed(() => (user.isLoggedIn ? user.info?.userid : undefined));
const accounts = computed(() => {
  const saved = [...user.savedAccounts];
  const current = user.info;
  if (user.isLoggedIn && current?.userid && current.token) {
    const index = saved.findIndex((account) => account.userid === current.userid);
    const summary: SavedAccount = {
      userid: current.userid,
      token: current.token,
      t1: current.t1,
      nickname: current.nickname,
      pic: current.pic,
      expires: current.expires,
      lastUsedAt: index >= 0 ? saved[index]!.lastUsedAt : 0,
      listeningSeconds: index >= 0 ? saved[index]!.listeningSeconds : undefined,
    };
    if (index >= 0) saved[index] = summary;
    else saved.push(summary);
  }
  return saved.sort((a, b) => {
    if (a.userid === currentId.value) return -1;
    if (b.userid === currentId.value) return 1;
    return b.lastUsedAt - a.lastUsedAt;
  });
});
const currentListeningSeconds = computed(() => {
  const detail = user.info?.extendsInfo?.detail ?? user.info?.detail;
  return getListeningSeconds(detail?.d_sec, detail?.duration);
});
const accountDuration = (account: SavedAccount) => {
  const seconds =
    (account.userid === currentId.value ? currentListeningSeconds.value : null) ??
    durations.value[account.userid] ??
    account.listeningSeconds;
  if (seconds !== undefined && seconds !== null)
    return `${Math.floor(seconds / 60).toLocaleString('zh-CN')} 分钟`;
  return loadingDurations.value.has(account.userid) ? '正在获取…' : '暂无数据';
};

watch(
  [open, ...userSessionSources(user)],
  async ([isOpen], _, onCleanup) => {
    let active = true;
    onCleanup(() => {
      active = false;
    });
    if (!isOpen) return;
    durations.value = {};
    loadingDurations.value = new Set(accounts.value.map((account) => account.userid));
    // 同步失效旧请求，但等账号 $patch 完成后再读取新身份并发起查询。
    await nextTick();
    if (!active || !open.value) return;
    const ids = accounts.value.map((account) => account.userid);
    loadingDurations.value = new Set(ids);
    await Promise.allSettled(
      ids.map(async (userid) => {
        try {
          let seconds: number | null;
          if (userid === currentId.value) {
            await user.fetchGradeInfo();
            seconds = currentListeningSeconds.value;
          } else {
            const response = await getUserGradeInfo(userid);
            seconds = response?.status === 1 ? getListeningSeconds(response.data?.d_sec) : null;
          }
          if (!active || !open.value || seconds === null) return;
          durations.value = { ...durations.value, [userid]: seconds };
          user.updateSavedAccountListeningSeconds(userid, seconds);
        } finally {
          if (active) loadingDurations.value.delete(userid);
        }
      }),
    );
  },
  { immediate: true, flush: 'sync' },
);

watch(open, () => {
  managing.value = false;
  removal.value = null;
});
watchUserSession(user, () => {
  removal.value = null;
});

const switchAccount = (account: SavedAccount) => {
  if (account.userid === currentId.value) return;
  try {
    user.switchAccount(account.userid);
    open.value = false;
    toast.success(`已切换至 ${account.nickname || account.userid}`);
  } catch (error) {
    toast.warning(error instanceof Error ? error.message : '账号切换失败，请重试');
  }
};
const addAccount = () => {
  open.value = false;
  void router.push({ path: '/login', query: { from: router.currentRoute.value.fullPath } });
};
const removeAccount = () => {
  if (!removal.value) return;
  const userid = removal.value.userid;
  removal.value = null;
  if (userid === currentId.value) {
    toast.warning('当前登录账号不能移除，请先切换账号');
    return;
  }
  user.forgetAccount(userid);
  toast.success('已移除账号');
};
</script>

<template>
  <Dialog
    v-model:open="open"
    :title="managing ? '管理账号' : '切换账号'"
    :show-close="true"
    content-class="account-switcher-dialog"
    :content-style="{ width: '440px', maxWidth: 'calc(100vw - 32px)' }"
  >
    <template #title>
      <span class="badge-label">
        {{ managing ? '管理账号' : '切换账号' }}
        <Badge :count="accounts.length" tone="muted" />
      </span>
    </template>
    <div class="account-list">
      <div
        v-for="account in accounts"
        :key="account.userid"
        class="saved-account"
        :class="{ 'is-current': account.userid === currentId }"
      >
        <Avatar :src="account.pic" :size="44" class="saved-account-avatar rounded-full" />
        <div class="saved-account-info">
          <div class="saved-account-name">
            <strong>{{ account.nickname || `账号 ${account.userid}` }}</strong>
            <Tag
              v-if="account.userid === currentId"
              tone="accent"
              class="shrink-0"
              aria-current="true"
            >
              当前登录
            </Tag>
          </div>
          <p class="saved-account-meta">
            <span>ID: {{ account.userid }}</span>
            <span aria-label="累计听歌时长">听歌 {{ accountDuration(account) }}</span>
          </p>
        </div>
        <Button
          v-if="managing && account.userid !== currentId"
          variant="danger"
          size="xs"
          class="saved-account-action"
          @click="removal = account"
          >移除</Button
        >
        <Button
          v-else-if="!managing && account.userid !== currentId"
          variant="secondary"
          size="xs"
          class="saved-account-action"
          @click="switchAccount(account)"
          >切换</Button
        >
      </div>
      <p v-if="!accounts.length" class="account-empty">暂无保存的账号</p>
    </div>
    <template #footer>
      <div class="account-footer">
        <div class="account-footer-secondary">
          <Button
            v-if="accounts.length"
            variant="secondary"
            size="sm"
            @click="managing = !managing"
          >
            {{ managing ? '完成管理' : '管理账号' }}
          </Button>
        </div>
        <Button variant="primary" size="sm" @click="addAccount">添加账号</Button>
      </div>
    </template>
  </Dialog>
  <Dialog
    :open="removal !== null"
    title="移除账号"
    description="将清除本机保存的登录信息，再次使用需要重新登录。"
    @update:open="if (!$event) removal = null;"
  >
    <div v-if="removal" class="account-removal-summary">
      <Avatar :src="removal.pic" :size="40" class="saved-account-avatar rounded-full" />
      <div class="saved-account-info">
        <strong>{{ removal.nickname || `账号 ${removal.userid}` }}</strong>
        <p class="saved-account-meta">ID: {{ removal.userid }}</p>
      </div>
    </div>
    <template #footer>
      <Button variant="outline" size="sm" @click="removal = null">取消</Button>
      <Button variant="danger" size="sm" @click="removeAccount">确认移除</Button>
    </template>
  </Dialog>
</template>

<style scoped>
.account-list {
  display: grid;
  gap: 10px;
}
.saved-account {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border-radius: var(--radius-item);
  border: 1px solid var(--surface-outline);
  background: var(--control-muted-bg);
}
.saved-account.is-current {
  background: var(--control-active-bg);
}
.saved-account-avatar {
  flex: none;
}
.saved-account-info {
  display: grid;
  gap: 4px;
  flex: 1;
  min-width: 0;
}
.saved-account-name {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.saved-account-info strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  font-weight: 600;
}
.saved-account-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
  margin: 2px 0 0;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--color-text-secondary);
}
.saved-account-meta > span {
  white-space: nowrap;
}
.saved-account-action {
  flex: none;
  min-width: 56px;
}
.account-empty {
  padding: 24px 0;
  text-align: center;
  font-size: 12px;
  color: var(--color-text-secondary);
}
.account-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  gap: 12px;
}
.account-footer-secondary {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.account-removal-summary {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
  padding: 12px;
  border-radius: var(--radius-item);
  background: var(--control-muted-bg);
}
</style>
