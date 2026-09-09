<script setup lang="ts">
import { COMMENT_MAX_LENGTH, countCommentCharacters } from '@/utils/commentLimits';
import { handleComposerKeydown } from '@/utils/composerKeyboard';
import { computed, ref } from 'vue';
import type { Comment } from '@/models/comment';
import Button from '@/components/ui/Button.vue';
import { useUserStore } from '@/stores/user';
import { useToastStore } from '@/stores/toast';
import { iconX } from '@/icons';
const props = defineProps<{ target: Comment; send?: (content: string) => Promise<void> }>();
const emit = defineEmits<{ close: []; sent: [] }>();
const draft = ref('');
const busy = defineModel<boolean>('busy', { default: false });
const user = useUserStore();
const toast = useToastStore();
const count = computed(() => countCommentCharacters(draft.value));
async function submit() {
  if (
    count.value > COMMENT_MAX_LENGTH ||
    !props.send ||
    busy.value ||
    !draft.value.trim() ||
    !user.isLoggedIn
  )
    return;
  busy.value = true;
  try {
    await props.send(draft.value.trim());
    draft.value = '';
    toast.show('回复已提交，展示结果以平台审核为准', 'success');
    emit('sent');
  } catch (error) {
    toast.show(error instanceof Error ? error.message : '回复失败，草稿已保留', 'danger');
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <form class="floor-composer" @submit.prevent="submit">
    <div class="floor-composer-heading">
      <span
        >回复 <strong>{{ target.userName }}</strong></span
      >
      <Button
        variant="ghost"
        size="none"
        class="floor-close"
        :disabled="busy"
        aria-label="取消回复"
        @click="emit('close')"
        type="button"
        ><Icon :icon="iconX" width="16" height="16"
      /></Button>
    </div>
    <blockquote>{{ target.content }}</blockquote>
    <textarea
      @keydown="handleComposerKeydown($event, submit)"
      aria-description="Enter 发送，Shift + Enter 换行"
      v-model="draft"
      :aria-invalid="count > COMMENT_MAX_LENGTH"
      rows="3"
      :disabled="busy"
      :aria-label="`回复 ${target.userName}`"
      :placeholder="user.isLoggedIn ? '写下你的回复…' : '登录后即可回复'"
    />
    <div class="floor-composer-footer">
      <span :class="{ 'is-over-limit': count > COMMENT_MAX_LENGTH }"
        >{{ count }} / {{ COMMENT_MAX_LENGTH
        }}<span v-if="!send" class="floor-unavailable"> · 回复功能即将开放</span></span
      >
      <Button
        type="submit"
        size="xs"
        :disabled="count > COMMENT_MAX_LENGTH || !send || !draft.trim() || busy || !user.isLoggedIn"
        >{{ busy ? '发送中…' : '发送回复' }}</Button
      >
    </div>
  </form>
</template>
<style scoped>
.floor-composer {
  margin: 12px 0;
  padding: 14px;
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  background: var(--control-muted-bg);
}
.floor-composer-heading,
.floor-composer-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.floor-composer-heading {
  font-size: 12px;
  color: var(--text-secondary);
}
strong {
  color: var(--text-main);
  font-weight: 600;
}
.floor-close {
  padding: 4px;
  border-radius: 6px;
}
blockquote {
  margin: 8px 0 12px;
  padding-left: 10px;
  border-left: 2px solid var(--control-border);
  color: var(--text-secondary);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
textarea {
  box-sizing: border-box;
  width: 100%;
  resize: vertical;
  min-height: 80px;
  max-height: 180px;
  padding: 10px 12px;
  font: inherit;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-main);
  border: 1px solid var(--control-border);
  border-radius: 8px;
  background: var(--color-bg-elevated);
  user-select: text;
}
textarea:focus {
  outline: 2px solid var(--color-primary);
  outline-offset: 1px;
}
.floor-composer-footer {
  margin-top: 10px;
  font-size: 11px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}
.floor-unavailable {
  opacity: 0.8;
}
.is-over-limit {
  color: #ef4444;
}
</style>
