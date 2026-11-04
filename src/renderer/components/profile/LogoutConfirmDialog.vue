<script setup lang="ts">
import { ref, watch } from 'vue';
import Button from '@/components/ui/Button.vue';
import Checkbox from '@/components/ui/Checkbox.vue';
import Dialog from '@/components/ui/Dialog.vue';

const open = defineModel<boolean>('open', { default: false });
const emit = defineEmits<{
  (e: 'confirm', keepAccount: boolean): void;
}>();

// 默认不保留凭证；每次打开都重置，避免沿用上一次的勾选。
const keepAccount = ref(false);
watch(open, (value) => {
  if (value) keepAccount.value = false;
});

const confirm = () => {
  emit('confirm', keepAccount.value);
};
</script>

<template>
  <Dialog v-model:open="open" title="退出登录" description="确定要退出当前账号吗？">
    <label class="flex items-start gap-2.5 mt-4 cursor-pointer select-none">
      <Checkbox
        :model-value="keepAccount"
        aria-label="保留登录信息"
        @update:model-value="keepAccount = $event === true"
      />
      <span class="grid gap-0.5 min-w-0">
        <strong class="text-[13px] font-medium text-text-main">保留登录信息</strong>
        <small class="text-[12px] leading-relaxed text-text-secondary"
          >退出后可在账号列表中直接切换回来，无需重新登录</small
        >
      </span>
    </label>
    <template #footer>
      <Button variant="outline" size="default" @click="open = false">取消</Button>
      <Button variant="danger" size="default" @click="confirm">确认退出</Button>
    </template>
  </Dialog>
</template>
