<template>
  <n-modal
    v-model:show="showDialog"
    preset="dialog"
    title="用户条款"
    :closable="false"
    :close-on-esc="false"
    :mask-closable="false"
    style="width: 600px; max-width: 90vw"
    positive-text="同意并继续"
    negative-text="不同意并退出"
    @positive-click="handleAgree"
    @negative-click="handleDisagree"
  >
    <div class="agreement-content">
      <n-scrollbar style="max-height: 60vh">
        <div class="content-section">
          <p>
            <strong>1.</strong>
            本程序是酷狗第三方客户端，并非酷狗官方，需要更完善的功能请下载官方客户端体验。
          </p>
          <p>
            <strong>2.</strong>
            本项目仅供学习交流使用，您在使用过程中应尊重版权，不得用于商业或非法用途。
          </p>
          <p>
            <strong>3.</strong>
            在使用本项目的过程中，可能会生成版权内容。本项目不拥有这些版权内容的所有权。为了避免侵权行为，您需在
            24 小时内清除由本项目产生的版权内容。
          </p>
          <p>
            <strong>4.</strong>
            本项目的开发者不对因使用或无法使用本项目所导致的任何损害承担责任，包括但不限于数据丢失、停工、计算机故障或其他经济损失。
          </p>
          <p>
            <strong>5.</strong>
            您不得在违反当地法律法规的情况下使用本项目。因违反法律法规所导致的任何法律后果由用户承担。
          </p>
          <p>
            <strong>6.</strong>
            本项目仅用于技术探索和研究，不接受任何商业合作、广告或捐赠。如果官方音乐平台对此项目存有疑虑，可随时联系开发者移除相关内容。
          </p>
        </div>

        <div class="content-footer">
          <p class="highlight">同意继续使用本项目，您即接受以上条款声明内容。</p>
        </div>
      </n-scrollbar>
    </div>
  </n-modal>
</template>

<script setup lang="ts">
import { NModal, NScrollbar } from 'naive-ui';
import { ref, onMounted } from 'vue';
import { useSettingStore } from '@/store';

const settingStore = useSettingStore();
const showDialog = ref(false);

onMounted(() => {
  // 检查用户是否已经同意过条款
  if (!settingStore.userAgreementAccepted) {
    showDialog.value = true;
  }
});

const handleAgree = () => {
  // 记录用户同意
  settingStore.acceptUserAgreement();
  showDialog.value = false;
};

const handleDisagree = () => {
  // 用户不同意，退出应用
  if (typeof window !== 'undefined' && window.require) {
    try {
      const { ipcRenderer } = window.require('electron');
      ipcRenderer.send('quit-app');
    } catch (error) {
      console.error('无法退出应用:', error);
      window.close();
    }
  } else {
    window.close();
  }
};
</script>

<style scoped>
.agreement-content {
  padding: 16px 0;
}

.content-section {
  margin-bottom: 24px;
}

.content-section h3 {
  font-size: 18px;
  font-weight: 600;
  margin-bottom: 12px;
  color: var(--n-title-text-color);
}

.content-section p {
  margin-bottom: 12px;
  line-height: 1.6;
  color: var(--n-text-color);
}

.content-section p strong {
  font-weight: 600;
  margin-right: 4px;
}

.content-footer {
  margin-top: 24px;
  padding-top: 16px;
  border-top: 1px solid var(--n-divider-color);
}

.content-footer .highlight {
  font-weight: 600;
  text-align: center;
  font-size: 15px;
  color: var(--n-title-text-color);
}
</style>
