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
                v-if="tvip"
              >
                <template #trigger>
                  <div class="vip-tag-wrapper">
                    <NTag
                      class="vip-tag"
                      size="small"
                      round
                      :type="tvip.is_vip === 1 ? 'success' : 'default'"
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
                      :type="svip.is_vip === 1 ? 'warning' : 'default'"
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
                style="font-size: 11px"
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
    <div class="item">
      <NH5
        class="title"
        prefix="bar"
      >
        账号信息
      </NH5>
    </div>
    <NCard size="small">
      <NDescriptions
        label-placement="left"
        :column="2"
      >
        <NDescriptionsItem label="用户ID">
          {{ userStore.userid }}
        </NDescriptionsItem>
        <NDescriptionsItem label="用户性别">
          {{ gender }}
        </NDescriptionsItem>
        <NDescriptionsItem label="听歌时长">
          {{ duration }}
        </NDescriptionsItem>
        <NDescriptionsItem label="用户乐龄">
          {{ rtime }}
        </NDescriptionsItem>
        <NDescriptionsItem label="所在城市">
          {{ city }}
        </NDescriptionsItem>
        <NDescriptionsItem label="IP属地">
          {{ location }}
        </NDescriptionsItem>
      </NDescriptions>
    </NCard>
    <div class="item">
      <NH5
        class="title"
        prefix="bar"
      >
        会员信息
      </NH5>
    </div>
    <NCard
      size="small"
      style="height: 570px"
      :title="formatTimestamp(new Date().getTime(), 'YYYY-MM-DD')"
    >
      <template #header-extra>
        <NText
          style="font-size: 12px"
          depth="3"
        >
          每天可领取畅听VIP并升级至概念VIP
        </NText>
      </template>
      <div class="flex flex-col space-y-6 p-4">
        <!-- Step 1: TVIP -->
        <NCard
          size="small"
          :bordered="true"
          class="vip-step-card"
        >
          <div class="flex items-center justify-between">
            <div class="flex items-center space-x-3">
              <NIcon
                :size="32"
                :color="
                  userStore.isTvipClaimedToday ? themeVars.successColor : themeVars.textColor3
                "
              >
                <CheckCircleRound v-if="userStore.isTvipClaimedToday" />
                <CheckCircleOutlineRound v-else />
              </NIcon>
              <div>
                <NText
                  strong
                  style="font-size: 15px"
                >
                  步骤 1: 领取畅听VIP
                </NText>
                <NText
                  depth="3"
                  style="font-size: 12px; display: block; margin-top: 4px"
                >
                  解锁基础听歌权限，普通音质
                </NText>
              </div>
            </div>
            <NButton
              size="small"
              :type="userStore.isTvipClaimedToday ? 'success' : 'primary'"
              :disabled="userStore.isTvipClaimedToday || loading"
              :loading="loading"
              @click="handleClaimTvip"
            >
              {{ userStore.isTvipClaimedToday ? '已领取' : '领取TVIP' }}
            </NButton>
          </div>
        </NCard>

        <!-- Arrow -->
        <div class="flex justify-center">
          <NIcon
            :size="24"
            :color="themeVars.textColor3"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
            >
              <path
                fill="currentColor"
                d="M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6l-6-6l1.41-1.41z"
              />
            </svg>
          </NIcon>
        </div>

        <!-- Step 2: SVIP -->
        <NCard
          size="small"
          :bordered="true"
          class="vip-step-card"
        >
          <div class="flex items-center justify-between">
            <div class="flex items-center space-x-3">
              <NIcon
                :size="32"
                :color="
                  userStore.isSvipClaimedToday ? themeVars.warningColor : themeVars.textColor3
                "
              >
                <CheckCircleRound v-if="userStore.isSvipClaimedToday" />
                <CheckCircleOutlineRound v-else />
              </NIcon>
              <div>
                <NText
                  strong
                  style="font-size: 15px"
                >
                  步骤 2: 升级至概念VIP
                </NText>
                <NText
                  depth="3"
                  style="font-size: 12px; display: block; margin-top: 4px"
                >
                  解锁顶级音质和音效特权
                </NText>
                <NText
                  v-if="!userStore.isTvipClaimedToday"
                  depth="3"
                  type="warning"
                  style="font-size: 11px; display: block; margin-top: 4px"
                >
                  需要先完成步骤1
                </NText>
              </div>
            </div>
            <NButton
              size="small"
              :type="userStore.isSvipClaimedToday ? 'warning' : 'primary'"
              :disabled="!userStore.isTvipClaimedToday || userStore.isSvipClaimedToday || loading"
              :loading="loading"
              @click="handleClaimSvip"
            >
              {{ userStore.isSvipClaimedToday ? '已升级' : '升级SVIP' }}
            </NButton>
          </div>
        </NCard>

        <!-- Status summary -->
        <NCard
          v-if="userStore.isVipReceiveCompleted"
          size="small"
          :bordered="false"
          style="background-color: rgba(24, 160, 88, 0.1)"
        >
          <div class="flex items-center space-x-2">
            <NIcon
              :size="20"
              :color="themeVars.successColor"
            >
              <CheckCircleRound />
            </NIcon>
            <NText
              :style="{ color: themeVars.successColor }"
              strong
            >
              今日VIP已全部领取完成！
            </NText>
          </div>
        </NCard>
      </div>
    </NCard>
  </div>
</template>

<script setup lang="ts">
import { useUserStore } from '@/store';
import { formatMinutesToHM, formatTimeDiff, formatTimestamp, getCover } from '@/utils';
import {
  NAvatar,
  NButton,
  NCard,
  NDescriptions,
  NDescriptionsItem,
  NDivider,
  NEllipsis,
  NH5,
  NIcon,
  NPopover,
  NTag,
  NText,
  useThemeVars,
} from 'naive-ui';
import { computed, onMounted } from 'vue';
import { RefreshRound, CheckCircleOutlineRound, CheckCircleRound } from '@vicons/material';
import { ref } from 'vue';
import { autoSignService } from '@/utils/sign';

defineOptions({
  name: 'Profile',
});

const userStore = useUserStore();

const avatarSize = 100;

const loading = ref(false);

const themeVars = useThemeVars();

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

// 性别
const gender = computed(() => {
  return userStore.extends?.detail?.gender === 1
    ? '男'
    : userStore.extends?.detail?.gender === 0
      ? '女'
      : '保密';
});

// IP属地
const location = computed(() => {
  return userStore.extends?.detail?.loc || '未知';
});

// 城市
const city = computed(() => {
  return userStore.extends?.detail?.city || '未知';
});

// 听歌时长
const duration = computed(() => {
  const dur = userStore.extends?.detail?.duration || 0;
  return formatMinutesToHM(dur);
});

// 用户乐龄
const rtime = computed(() => {
  const rt = userStore.extends?.detail?.rtime * 1000 || 0;
  return formatTimeDiff(rt);
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

const handleClaimTvip = async () => {
  try {
    loading.value = true;
    await autoSignService.manualSign();
    if (window.$message) {
      window.$message.success('领取畅听VIP成功');
    }
  } catch (error) {
    console.error('领取失败', error);
    if (window.$message) {
      window.$message.error((error as Error).message || '领取失败');
    }
    // 如果提示已领取，同步状态
    if ((error as Error).message === '今日已领取畅听VIP') {
      await syncVipStatus();
    }
  } finally {
    loading.value = false;
  }
};

// 同步VIP状态
const syncVipStatus = async () => {
  try {
    const userStore = useUserStore();
    // 通过检查月度记录来判断TVIP是否已领取
    const monthRecord = await autoSignService.getVipMonthRecord();
    const today = formatTimestamp(new Date().getTime());
    const tvipClaimed = monthRecord?.some((item: any) => item.day === today) || false;

    // 更新状态，保留SVIP的状态
    userStore.setVipReceive({
      day: new Date().getTime(),
      tvipClaimed,
      svipClaimed: userStore.vipReceive?.svipClaimed || false,
    });
  } catch (error) {
    console.error('同步VIP状态失败', error);
  }
};

const handleClaimSvip = async () => {
  try {
    loading.value = true;
    await autoSignService.manualReceiveVip();
    if (window.$message) {
      window.$message.success('升级概念VIP成功');
    }
  } catch (error: any) {
    console.error('升级失败', error);

    // 如果错误码是297002，说明已经升级过，同步状态
    if (error?.error_code === 297002 || error?.message === '今日概念VIP已升级') {
      const userStore = useUserStore();
      userStore.setVipReceive({
        day: new Date().getTime(),
        tvipClaimed: true,
        svipClaimed: true,
      });
      if (window.$message) {
        window.$message.info('已经升级过概念VIP');
      }
      return;
    }

    if (window.$message) {
      window.$message.error(error?.message || '升级失败');
    }
  } finally {
    loading.value = false;
  }
};

onMounted(async () => {
  await userStore.fetchUserExtends();
  // 同步VIP状态
  await syncVipStatus();
});
</script>

<style scoped lang="scss">
.profile {
  .nickname {
    font-size: 18px;
  }

  .item {
    .title {
      margin: 0;
    }
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

.calender {
  :deep(.n-calendar) {
    height: auto;
    font-size: 12px;
  }

  :deep(.n-calendar-header) {
    display: none;
  }

  :deep(.n-calendar .n-calendar-cell) {
    padding-top: 15px;
    height: 100px;
  }
}
</style>
