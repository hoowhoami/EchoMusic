<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import Dialog from '@/components/ui/Dialog.vue';
import Button from '@/components/ui/Button.vue';
import {
  audiobookPromptState,
  cancelAudiobookResumePrompt,
  confirmAudiobookResumePrompt,
} from '@/utils/audiobookResumePrompt';

const router = useRouter();

const title = computed(() =>
  audiobookPromptState.mode === 'same'
    ? '有声/长专检测到同一集播放记录，是否跳转至详情页继续播放？'
    : '有声/长专检测到另一集播放记录，是否跳转至上次播放？',
);

/** 否：不跳转，继续播放当前这首。不一致时进度记在 single 上，不认领续播卡。 */
const onReject = () => {
  cancelAudiobookResumePrompt();
};

/** 是：带参数跳转到有声/长专详情页，从记录位置继续收听。 */
const onConfirm = () => {
  confirmAudiobookResumePrompt();
  void router.push({
    name: 'album-detail',
    params: { id: audiobookPromptState.albumId },
    query: { locate: 'resume', category: '2' },
  });
};
</script>

<template>
  <Dialog
    v-model:open="audiobookPromptState.open"
    content-class="audiobook-resume-prompt"
    :title="title"
  >
    <template #footer>
      <Button variant="solid-primary" class="audiobook-prompt-btn" @click="onConfirm">
        跳转
      </Button>
      <Button variant="outline" class="audiobook-prompt-btn" @click="onReject"> 继续播放 </Button>
    </template>
  </Dialog>
</template>

<style scoped>
@reference "@/style.css";

:global(.dialog-content.audiobook-resume-prompt .audiobook-prompt-btn) {
  min-width: 96px;
}
</style>
