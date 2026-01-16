<template>
  <n-modal
    v-model:show="props.show"
    preset="dialog"
    title="免责声明"
    :closable="true"
    style="width: 600px; max-width: 90vw"
    positive-text="关闭"
    @positive-click="handleClose"
  >
    <div class="disclaimer-content">
      <n-scrollbar style="max-height: 60vh">
        <div class="content-section">
          <p>
            <strong>0.</strong>
            本程序是酷狗第三方客户端，并非酷狗官方，需要更完善的功能请下载官方客户端体验。
          </p>
          <p>
            <strong>1.</strong>
            本项目仅供学习使用，请尊重版权，请勿利用此项目从事商业行为及非法用途！
          </p>
          <p>
            <strong>2.</strong>
            使用本项目的过程中可能会产生版权数据。对于这些版权数据，本项目不拥有它们的所有权。为了避免侵权，使用者务必在
            24 小时内清除使用本项目的过程中所产生的版权数据。
          </p>
          <p>
            <strong>3.</strong>
            由于使用本项目产生的包括由于本协议或由于使用或无法使用本项目而引起的任何性质的任何直接、间接、特殊、偶然或结果性损害（包括但不限于因商誉损失、停工、计算机故障或故障引起的损害赔偿，或任何及所有其他商业损害或损失）由使用者负责。
          </p>
          <p>
            <strong>4.</strong>
            禁止在违反当地法律法规的情况下使用本项目。对于使用者在明知或不知当地法律法规不允许的情况下使用本项目所造成的任何违法违规行为由使用者承担，本项目不承担由此造成的任何直接、间接、特殊、偶然或结果性责任。
          </p>
          <p><strong>5.</strong> 音乐平台不易，请尊重版权，支持正版。</p>
          <p>
            <strong>6.</strong>
            本项目仅用于对技术可行性的探索及研究，不接受任何商业（包括但不限于广告等）合作及捐赠。
          </p>
          <p><strong>7.</strong> 如果官方音乐平台觉得本项目不妥，可联系本项目更改或移除。</p>
        </div>
      </n-scrollbar>
    </div>
  </n-modal>
</template>

<script setup lang="ts">
import { NModal, NScrollbar } from 'naive-ui';

interface Props {
  show: boolean;
}

const props = defineProps<Props>();

const emit = defineEmits<{
  'update:show': [value: boolean];
}>();

const handleClose = () => {
  emit('update:show', false);
};
</script>

<style scoped>
.disclaimer-content {
  padding: 16px 0;
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
</style>
