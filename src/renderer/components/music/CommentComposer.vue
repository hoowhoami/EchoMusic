<script setup lang="ts">
import {
  BARRAGE_MAX_LENGTH,
  COMMENT_MAX_LENGTH,
  countCommentCharacters,
} from '@/utils/commentLimits';
import { handleComposerKeydown } from '@/utils/composerKeyboard';
import { computed, watch } from 'vue';
import { sendComment, type CommentSendResource } from '@/api/comment';
import { useUserStore } from '@/stores/user';
import { useToastStore } from '@/stores/toast';
import Button from '@/components/ui/Button.vue';

const props = defineProps<{ resource: CommentSendResource; label?: string; variant?: 'barrage' }>();
const emit = defineEmits<{ sent: [content: string] }>();
const user = useUserStore();
const toast = useToastStore();
const content = defineModel<string>('content', { default: '' });
const sending = defineModel<boolean>('sending', { default: false });
const limit = computed(() =>
  props.resource.type.endsWith('-barrage') ? BARRAGE_MAX_LENGTH : COMMENT_MAX_LENGTH,
);
const count = computed(() => countCommentCharacters(content.value));
const overLimit = computed(() => count.value > limit.value);
const key = computed(
  () => `${props.resource.type}:${props.resource.id || ''}:${props.resource.hash || ''}`,
);
const available = computed(() =>
  Boolean(props.resource.type.endsWith('-barrage') ? props.resource.hash : props.resource.id),
);
watch(key, () => {
  content.value = '';
});
async function submit() {
  if (overLimit.value || sending.value || !content.value.trim() || !available.value) return;
  if (!user.isLoggedIn) {
    toast.show('请先登录后再发送', 'warning');
    return;
  }
  const startedKey = key.value;
  const text = content.value.trim();
  sending.value = true;
  try {
    await sendComment({ ...props.resource }, text);
    toast.show('已提交，展示结果以平台审核为准', 'success');
    if (startedKey === key.value) {
      content.value = '';
      emit('sent', text);
    }
  } catch (error) {
    toast.show(error instanceof Error ? error.message : '发送失败，请稍后重试', 'danger');
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <form
    class="comment-composer no-drag"
    :class="{ 'is-barrage': variant === 'barrage' }"
    @submit.prevent="submit"
  >
    <textarea
      @keydown="handleComposerKeydown($event, submit)"
      aria-description="Enter 发送，Shift + Enter 换行"
      v-model="content"
      :aria-invalid="overLimit"
      :disabled="sending || !available"
      :rows="variant === 'barrage' ? 3 : 1"
      :aria-label="label || '发表评论'"
      :placeholder="user.isLoggedIn ? label || '写下你的评论…' : '登录后即可发送'"
    />
    <div v-if="variant === 'barrage'" class="composer-footer">
      <span class="composer-count" :class="{ 'is-over-limit': overLimit }"
        >{{ count }} / {{ limit }}</span
      >
      <Button
        type="submit"
        size="xs"
        :disabled="overLimit || sending || !content.trim() || !available || !user.isLoggedIn"
      >
        {{ sending ? '发送中…' : '发送' }}
      </Button>
    </div>
    <span
      v-if="variant !== 'barrage'"
      class="composer-count"
      :class="{ 'is-over-limit': overLimit }"
      >{{ count }} / {{ limit }}</span
    >
    <Button
      v-if="variant !== 'barrage'"
      class="comment-send"
      type="submit"
      size="xs"
      :disabled="overLimit || sending || !content.trim() || !available || !user.isLoggedIn"
    >
      {{ sending ? '发送中…' : '发送' }}
    </Button>
  </form>
</template>

<style scoped>
.comment-composer {
  display: flex;
  gap: 12px;
  align-items: flex-end;
  padding: 10px 12px;
  flex-shrink: 0;
}
textarea {
  flex: 1;
  min-width: 0;
  box-sizing: border-box;
  resize: none;
  min-height: 32px;
  max-height: 112px;
  field-sizing: content;
  padding: 6px 4px;
  border: none;
  background: transparent;
  color: var(--text-main);
  font: inherit;
  font-size: 13px;
  line-height: 20px;
  user-select: text;
}
textarea::placeholder {
  color: var(--text-secondary);
  opacity: 0.75;
}
textarea:focus {
  outline: none;
}
.comment-composer:not(.is-barrage) {
  border: 1px solid var(--control-border);
  border-radius: 14px;
  background: var(--color-bg-elevated);
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.045);
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
}
.comment-composer:not(.is-barrage):focus-within {
  border-color: color-mix(in srgb, var(--color-primary) 55%, var(--control-border));
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-primary) 8%, transparent);
}
.comment-send {
  flex-shrink: 0;
  min-width: 60px;
  font-weight: 600;
}
.is-barrage {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 12px;
  padding: 0;
}
.is-barrage textarea {
  box-sizing: border-box;
  width: 100%;
  min-height: 112px;
  max-height: 112px;
  resize: none;
  padding: 12px 14px;
  font-size: 14px;
  line-height: 1.6;
  border: 1px solid var(--control-border);
  background: var(--control-muted-bg);
  border-radius: 12px;
  transition:
    border-color 0.15s,
    box-shadow 0.15s;
}
.is-barrage textarea:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-primary) 12%, transparent);
}
.composer-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.composer-count {
  flex-shrink: 0;
  white-space: nowrap;
  color: var(--text-secondary);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.composer-footer > button {
  min-width: 72px;
  font-weight: 600;
}
.is-over-limit {
  color: #ef4444;
}
</style>
