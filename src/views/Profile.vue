<template>
  <div class="profile flex flex-col space-y-4">
    <NCard
      size="small"
      hoverable
    >
      <div class="flex justify-between">
        <div class="flex items-center space-x-4">
          <NAvatar
            round
            :size="avatarSize"
            :src="avatar"
          />
          <div class="flex flex-col space-y-2">
            <div class="flex items-center space-x-2">
              <NText
                strong
                depth="1"
                class="nickname"
              >
                {{ nickname }}
              </NText>
              <NPopover
                trigger="hover"
                v-if="svip"
              >
                <template #trigger>
                  <div class="vip-tag-wrapper">
                    <NTag
                      class="vip-tag"
                      size="small"
                      round
                      :type="svip.is_vip === 1 ? 'success' : 'default'"
                    >
                      SVIP
                    </NTag>
                  </div>
                </template>
                <div style="font-size: 12px">
                  <NGradientText> 酷狗概念版VIP </NGradientText>
                </div>
                <div
                  style="font-size: 11px"
                  class="flex items-center space-x-1"
                >
                  <NIcon :size="12">
                    <AccessTimeRound />
                  </NIcon>
                  <NText depth="2"> {{ svip.vip_begin_time }} ~ {{ svip.vip_end_time }} </NText>
                </div>
              </NPopover>

              <NPopover
                trigger="hover"
                v-if="tvip"
              >
                <template #trigger>
                  <div class="vip-tag-wrapper">
                    <NTag
                      class="vip-tag"
                      size="small"
                      round
                      :type="tvip.is_vip === 1 ? 'warning' : 'default'"
                    >
                      TVIP
                    </NTag>
                  </div>
                </template>
                <div style="font-size: 12px">
                  <NGradientText type="warning"> 酷狗畅听版VIP </NGradientText>
                </div>
                <div
                  style="font-size: 11px"
                  class="flex items-center space-x-1"
                >
                  <NIcon :size="12">
                    <AccessTimeRound />
                  </NIcon>
                  <NText depth="2"> {{ tvip.vip_begin_time }} ~ {{ tvip.vip_end_time }} </NText>
                </div>
              </NPopover>
            </div>
            <div
              class="flex items-center space-x-2"
              style="font-size: 12px"
            >
              <NText depth="2"> Lv.{{ level }} </NText>
              <NDivider vertical />
              <NText depth="2"> {{ follows }} 关注 </NText>
              <NText depth="2"> {{ fans }} 粉丝 </NText>
              <NText depth="2"> {{ visitors }} 访客 </NText>
            </div>
            <NEllipsis :line-clamp="1">
              <NText
                depth="3"
                style="font-size: 10px"
              >
                个性签名: {{ intro }}
              </NText>
            </NEllipsis>
          </div>
        </div>
        <div>
          <NButton
            :focusable="false"
            text
            :loading="loading"
            @click="handleRefresh"
          >
            <template #icon>
              <NIcon>
                <RefreshRound />
              </NIcon>
            </template>
          </NButton>
        </div>
      </div>
    </NCard>
    <NCard size="small"> Come Soon... </NCard>
  </div>
</template>

<script setup lang="ts">
import { useUserStore } from '@/store';
import { getCover } from '@/utils';
import {
  NAvatar,
  NButton,
  NCard,
  NDivider,
  NEllipsis,
  NGradientText,
  NIcon,
  NPopover,
  NTag,
  NText,
} from 'naive-ui';
import { computed } from 'vue';
import { RefreshRound, AccessTimeRound } from '@vicons/material';
import { ref } from 'vue';

defineOptions({
  name: 'Profile',
});

const userStore = useUserStore();

const avatarSize = 100;

const loading = ref(false);

// 头像
const avatar = computed(() => {
  return getCover(userStore.pic || '', avatarSize);
});

// 昵称
const nickname = computed(() => {
  return userStore.nickname || userStore.username || userStore.userid;
});

// 等级
const level = computed(() => {
  return userStore.extends?.detail?.p_grade || 0;
});

// 个性签名
const intro = computed(() => {
  return userStore.extends?.detail?.descri || '暂无';
});

// 关注数
const follows = computed(() => {
  return userStore.extends?.detail?.follows || 0;
});

// 粉丝数
const fans = computed(() => {
  return userStore.extends?.detail?.fans || 0;
});

// 访客数
const visitors = computed(() => {
  return userStore.extends?.detail?.nvisitors || 0;
});

const vips = computed(() => {
  return userStore.extends?.vip?.busi_vip || [];
});

// SVIP 酷狗概念版会员
const svip = computed(() => {
  return vips.value.filter(
    (item: { is_vip: number; product_type: string }) =>
      item.is_vip === 1 && item.product_type === 'svip',
  )?.[0];
});

// TVIP 畅听会员
const tvip = computed(() => {
  return vips.value.filter(
    (item: { is_vip: number; product_type: string }) =>
      item.is_vip === 1 && item.product_type === 'tvip',
  )?.[0];
});

const handleRefresh = async () => {
  try {
    loading.value = true;
    await userStore.fetchUserExtends();
  } catch (error) {
    console.error('获取用户信息失败', error);
  } finally {
    loading.value = false;
  }
};
</script>

<style scoped lang="scss">
.profile {
  .nickname {
    font-size: 18px;
  }
}

.vip-tag {
  cursor: pointer;
  font-size: 10px;
  line-height: 18px;
}

:deep(.vip-tag-wrapper > .n-tag) {
  height: 18px;
}
</style>
