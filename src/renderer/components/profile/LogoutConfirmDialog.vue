<script setup lang="ts">
import Button from '@/components/ui/Button.vue';
import Dialog from '@/components/ui/Dialog.vue';

const open = defineModel<boolean>('open', { default: false });
const emit = defineEmits<{ confirm: [] }>();
</script>

<template>
  <Dialog v-model:open="open" title="退出登录" description="确定要退出当前账号吗？">
    <template #footer>
      <Button variant="outline" size="sm" @click="open = false">取消</Button>
      <Button variant="danger" size="sm" @click="emit('confirm')">确认退出</Button>
    </template>
  </Dialog>
</template>
