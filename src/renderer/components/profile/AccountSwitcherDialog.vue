<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import Avatar from '@/components/ui/Avatar.vue';
import Button from '@/components/ui/Button.vue';
import Dialog from '@/components/ui/Dialog.vue';
import { useUserStore, type SavedAccount } from '@/stores/user';
import { useToastStore } from '@/stores/toast';

const open = defineModel<boolean>('open', { default: false });
const user = useUserStore();
const toast = useToastStore();
const router = useRouter();
const managing = ref(false);
const removal = ref<SavedAccount | null>(null);
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
const isRemovingCurrent = computed(() => removal.value?.userid === currentId.value);

watch(open, () => {
  managing.value = false;
  removal.value = null;
});
watch(
  () => user.accountRevision,
  () => {
    removal.value = null;
  },
);

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
  user.forgetAccount(userid);
};
</script>

<template>
  <Dialog
    v-model:open="open"
    title="切换账号"
    description="选择已保存的账号，或登录另一个账号"
    :show-close="true"
    :content-style="{ width: '420px', maxWidth: 'calc(100vw - 32px)' }"
  >
    <div class="account-list">
      <div v-for="account in accounts" :key="account.userid" class="saved-account">
        <Avatar :src="account.pic" :size="42" class="rounded-full" />
        <div class="saved-account-info">
          <strong>{{ account.nickname || `账号 ${account.userid}` }}</strong>
          <span>ID · {{ account.userid }}</span>
        </div>
        <Button v-if="managing" variant="danger" size="sm" @click="removal = account">移除</Button>
        <span v-else-if="account.userid === currentId" class="current-account">当前使用</span>
        <Button v-else variant="secondary" size="sm" @click="switchAccount(account)">切换</Button>
      </div>
      <p v-if="!accounts.length" class="account-empty">暂无保存的账号</p>
    </div>
    <template #footer>
      <div class="account-footer">
        <Button variant="outline" size="sm" @click="addAccount">添加账号</Button>
        <Button v-if="accounts.length" variant="ghost" size="sm" @click="managing = !managing">
          {{ managing ? '完成' : '管理' }}
        </Button>
      </div>
    </template>
  </Dialog>
  <Dialog
    :open="removal !== null"
    title="移除账号"
    :description="
      isRemovingCurrent
        ? '移除后将退出当前账号，再次使用需要重新登录。'
        : '移除后，再次使用此账号需要重新登录。'
    "
    @update:open="if (!$event) removal = null;"
  >
    <template #footer>
      <Button variant="outline" size="sm" @click="removal = null">取消</Button>
      <Button variant="danger" size="sm" @click="removeAccount">确认移除</Button>
    </template>
  </Dialog>
</template>

<style scoped>
.account-list {
  display: grid;
  gap: 8px;
  margin-top: 12px;
}
.saved-account {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-control);
}
.saved-account-info {
  display: grid;
  gap: 4px;
  flex: 1;
  min-width: 0;
}
.saved-account-info strong {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  font-weight: 600;
}
.saved-account-info > span,
.account-empty {
  font-size: 12px;
  color: var(--color-text-secondary);
}
.current-account {
  flex: none;
  font-size: 12px;
  color: var(--color-primary);
}
.account-empty {
  padding: 24px 0;
  text-align: center;
}
.account-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
}
</style>
