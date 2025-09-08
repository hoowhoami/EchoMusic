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
    <NTabs
      type="segment"
      animated
      v-model:value="activeTab"
      @update:value="handleTabChange"
    >
      <NTabPane
        name="detail"
        tab="个人信息"
      >
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
      </NTabPane>
      <NTabPane
        name="svip"
        tab="概念会员"
      >
        <NCard
          size="small"
          :title="`${formatTimestamp(new Date().getTime(), 'YYYY-MM')}`"
        >
          <template #header-extra>
            <NText
              style="font-size: 12px"
              depth="3"
            >
              每天签到可领取一日会员
            </NText>
          </template>
          <div class="calender">
            <NCalendar
              :is-date-disabled="isDateDisabled"
              @update:value="handleSign"
            >
              <template #default="{ year, month, date }">
                <div class="mt-[10px] flex flex-col items-center space-y-1">
                  <div style="font-size: 12px">
                    <NIcon
                      v-if="isSigned(year, month, date)"
                      :size="20"
                      :color="themeVars.primaryColor"
                    >
                      <CheckCircleRound />
                    </NIcon>
                    <NIcon
                      v-if="
                        !isSigned(year, month, date) &&
                        isBeforeToday(toTimestamp(year, month, date))
                      "
                      :size="20"
                    >
                      <CheckCircleOutlineRound />
                    </NIcon>
                    <NIcon
                      :size="20"
                      :color="themeVars.infoColor"
                      v-if="!isSigned(year, month, date) && isToday(toTimestamp(year, month, date))"
                    >
                      <CheckCircleOutlineRound />
                    </NIcon>
                  </div>
                  <div
                    style="font-size: 12px"
                    v-if="
                      isBeforeToday(toTimestamp(year, month, date)) ||
                      isToday(toTimestamp(year, month, date))
                    "
                  >
                    <NGradientText
                      depth="2"
                      :type="isSigned(year, month, date) ? 'success' : 'info'"
                    >
                      {{
                        isSigned(year, month, date)
                          ? '已签到'
                          : isToday(toTimestamp(year, month, date))
                            ? '点击签到'
                            : '未签到'
                      }}
                    </NGradientText>
                  </div>
                </div>
              </template>
            </NCalendar>
          </div>
        </NCard>
      </NTabPane>
      <NTabPane
        name="tvip"
        tab="畅听会员"
      >
        <NCard
          size="small"
          :title="formatTimestamp(new Date().getTime(), 'YYYY-MM-DD')"
        >
          <template #header-extra>
            <NText
              style="font-size: 12px"
              depth="3"
            >
              每天累计可领取一天会员时长,需要领取8次,每次增加3小时
            </NText>
          </template>
          <div class="flex justify-between">
            <NSteps
              size="small"
              vertical
              :current="vipReceiveStep"
              :status="vipReceiveStepStatus"
            >
              <NStep
                :title="`第${i}次`"
                v-for="i in 8"
                description="时长+3"
                :key="i"
              ></NStep>
            </NSteps>
            <div class="w-[500px] flex flex-col items-end space-y-2">
              <NButton
                size="small"
                :focusable="false"
                :loading="loading"
                :disabled="userStore.isVipReceiveCompleted"
                @click="handleReceiveVip"
              >
                领取
              </NButton>
              <div
                class="flex items-center space-x-1"
                v-if="
                  !userStore.isVipReceiveCompleted &&
                  userStore.vipReceiveNextTime &&
                  userStore.vipReceiveNextTime > new Date().getTime()
                "
              >
                <NIcon :size="12">
                  <AccessTimeRound />
                </NIcon>
                <NText
                  depth="3"
                  style="font-size: 12px"
                >
                  下一次领取时间为
                  {{ formatTimestamp(userStore.vipReceiveNextTime, 'YYYY-MM-DD HH:mm:ss') }} 之后
                </NText>
              </div>
            </div>
          </div>
        </NCard>
      </NTabPane>
    </NTabs>
  </div>
</template>

<script setup lang="ts">
import { useUserStore } from '@/store';
import {
  formatMinutesToHM,
  formatTimeDiff,
  formatTimestamp,
  getCover,
  isAfterToday,
  isBeforeToday,
  isToday,
} from '@/utils';
import {
  NAvatar,
  NButton,
  NCalendar,
  NCard,
  NDescriptions,
  NDescriptionsItem,
  NDivider,
  NEllipsis,
  NGradientText,
  NIcon,
  NPopover,
  NStep,
  NSteps,
  NTabPane,
  NTabs,
  NTag,
  NText,
  useThemeVars,
} from 'naive-ui';
import { computed } from 'vue';
import {
  RefreshRound,
  AccessTimeRound,
  CheckCircleOutlineRound,
  CheckCircleRound,
} from '@vicons/material';
import { ref } from 'vue';
import { youthDayVip, youthMonthVipRecord, youthVip } from '@/api';

defineOptions({
  name: 'Profile',
});

const userStore = useUserStore();

const avatarSize = 100;

const loading = ref(false);

const themeVars = useThemeVars();

const activeTab = ref('detail');

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

// 会员当月领取记录
const vipMonthRecord = ref([]);

// 会员当天领取进度
const vipReceiveStep = computed(() => {
  if (userStore.isVipReceiveCompleted) {
    return 8;
  }
  if (userStore.vipReceive) {
    if (isToday(userStore.vipReceive.day)) {
      return userStore.vipReceive.done;
    }
  }
  return 0;
});

const vipReceiveStepStatus = computed(() => {
  if (vipReceiveStep.value > 0) {
    return 'finish';
  }
  return 'wait';
});

const toTimestamp = (year: number, month: number, day: number) => {
  return new Date(year, month - 1, day).getTime();
};

const isSigned = (year: number, month: number, day: number): boolean => {
  const timestamp = toTimestamp(year, month, day);
  return vipMonthRecord.value?.some(
    (item: { day: string }) => item.day === formatTimestamp(timestamp),
  );
};

// 禁用日历日期
const isDateDisabled = (timestamp: number) => {
  if (isBeforeToday(timestamp) || isAfterToday(timestamp)) {
    return true;
  }
  return false;
};

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

const handleSign = async (
  timestamp: number,
  info: { year: number; month: number; date: number },
) => {
  try {
    if (loading.value) {
      return;
    }
    if (!isToday(timestamp)) {
      return;
    }
    const { year, month, date } = info;
    if (isSigned(year, month, date)) {
      return;
    }
    const time = `${year}-${month}-${date}`;
    console.log('签到日期', time);
    loading.value = true;
    const res = await youthDayVip();
    console.log('签到结果', res);
    await getVipReceiveResult();
    await userStore.fetchUserExtends();
  } catch (error) {
    console.error('签到失败', error);
  } finally {
    loading.value = false;
  }
};

const getVipReceiveResult = async () => {
  try {
    loading.value = true;
    vipMonthRecord.value = [];
    const monthRecord = await youthMonthVipRecord();
    vipMonthRecord.value = monthRecord.list;
  } catch (error) {
    console.error('获取用户VIP领取结果失败', error);
  } finally {
    loading.value = false;
  }
};

const handleReceiveVip = async () => {
  try {
    if (userStore.isVipReceiveCompleted) {
      window.$message.warning('今日会员已经领取完成');
      return;
    }
    if (userStore.vipReceiveNextTime && userStore.vipReceiveNextTime > new Date().getTime()) {
      window.$message.warning(
        `下一次领取时间为 ${formatTimestamp(userStore.vipReceiveNextTime, 'YYYY-MM-DD HH:mm:ss')} 之后`,
      );
      return;
    }
    loading.value = true;
    const res = await youthVip();
    console.log('领取结果', res);
    userStore.setVipReceive(res);
    await userStore.fetchUserExtends();
  } catch (error) {
    console.error('领取失败', error);
  } finally {
    loading.value = false;
  }
};

const handleTabChange = (tab: string) => {
  if (tab === 'detail') {
    userStore.fetchUserExtends();
  }
  if (tab === 'svip') {
    getVipReceiveResult();
  }
  if (tab === 'tvip') {
    // try
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
