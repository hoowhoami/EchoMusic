// 详情页「定位上次播放」的提示节奏：三页（专辑 / 有声/长专、歌手、歌单）共用一份，避免各自一套时限。
import { useToastStore } from '@/stores/toast';

/** 同一个定位提示 1.2 秒内不重复弹。 */
export const LOCATE_FEEDBACK_THROTTLE_MS = 1200;
/** 同样的内容 5 秒内只弹一次：定位会被重复触发，别让一句话刷两遍。 */
export const LOCATE_FEEDBACK_DEDUPE_MS = 5000;

export const createLocateFeedback = () => {
  let lastAt = 0;
  let lastMessage = '';
  let lastSameAt = 0;
  return {
    // 独占展示：新提示顶掉旧提示，重复点击也不会叠出角标
    show(message: string) {
      const now = Date.now();
      if (now - lastAt < LOCATE_FEEDBACK_THROTTLE_MS) return;
      if (message === lastMessage && now - lastSameAt < LOCATE_FEEDBACK_DEDUPE_MS) return;
      lastAt = now;
      if (message === lastMessage) lastSameAt = now;
      else {
        lastMessage = message;
        lastSameAt = now;
      }
      useToastStore().showExclusive(message, 'info');
    },
  };
};
