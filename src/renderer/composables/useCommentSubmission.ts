import { computed, watch, onBeforeUnmount, type Ref } from 'vue';
import { sendComment, type CommentSendResource } from '@/api/comment';
import {
  BARRAGE_MAX_LENGTH,
  COMMENT_MAX_LENGTH,
  countCommentCharacters,
} from '@/utils/commentLimits';
import { captureUserSession, userSessionSources } from '@/utils/userSession';
import { useUserStore } from '@/stores/user';
import { useToastStore } from '@/stores/toast';

/** 弹幕由外层控件持有此状态，验证码临时卸载输入框不会中断发送归属。 */
export function useCommentSubmission(options: {
  resource: () => CommentSendResource;
  content: Ref<string>;
  sending: Ref<boolean>;
  sent: (text: string) => void;
}) {
  const user = useUserStore();
  const toast = useToastStore();
  const { content, sending } = options;
  const key = computed(() =>
    JSON.stringify([
      options.resource().type,
      options.resource().id ?? '',
      options.resource().hash ?? '',
    ]),
  );
  const available = computed(() =>
    Boolean(
      options.resource().type.endsWith('-barrage')
        ? options.resource().hash
        : options.resource().id,
    ),
  );
  const overLimit = computed(
    () =>
      countCommentCharacters(content.value) >
      (options.resource().type.endsWith('-barrage') ? BARRAGE_MAX_LENGTH : COMMENT_MAX_LENGTH),
  );
  let generation = 0;
  let disposed = false;
  watch(
    [key, ...userSessionSources(user)],
    () => {
      generation++;
      content.value = '';
      sending.value = false;
    },
    { flush: 'sync' },
  );
  onBeforeUnmount(() => {
    disposed = true;
    generation++;
  });
  async function submit() {
    if (disposed || overLimit.value || sending.value || !content.value.trim() || !available.value)
      return;
    if (!user.isLoggedIn) {
      toast.show('请先登录后再发送', 'warning');
      return;
    }
    const startedKey = key.value;
    const requestGeneration = ++generation;
    const isSessionCurrent = captureUserSession(user);
    const isCurrent = () =>
      !disposed &&
      requestGeneration === generation &&
      startedKey === key.value &&
      isSessionCurrent();
    const draft = content.value;
    const text = content.value.trim();
    sending.value = true;
    try {
      await sendComment({ ...options.resource() }, text);
      if (!isCurrent()) return;
      toast.show('已提交，展示结果以平台审核为准', 'success');
      if (content.value === draft) content.value = '';
      options.sent(text);
    } catch (error) {
      if (isCurrent())
        toast.show(error instanceof Error ? error.message : '发送失败，请稍后重试', 'danger');
    } finally {
      if (isCurrent()) sending.value = false;
    }
  }
  return { submit };
}
