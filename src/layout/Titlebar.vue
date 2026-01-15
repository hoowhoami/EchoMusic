<template>
  <div class="titlebar drag">
    <div class="content flex items-center justify-between">
      <div class="no-drag nav">
        <div class="flex items-center space-x-4">
          <NButton
            ghost
            text
            :focusable="false"
            @click="router.go(-1)"
          >
            <template #icon>
              <NIcon :size="25">
                <ArrowBackCircleOutline />
              </NIcon>
            </template>
          </NButton>
          <NButton
            ghost
            text
            :focusable="false"
            @click="router.go(1)"
          >
            <template #icon>
              <NIcon :size="25">
                <ArrowForwardCircleOutline />
              </NIcon>
            </template>
          </NButton>
          <NButton
            ghost
            text
            :focusable="false"
            @click="refreshCurrentPage"
          >
            <template #icon>
              <NIcon :size="25">
                <RefreshCircleOutline />
              </NIcon>
            </template>
          </NButton>
          <div class="no-drag flex justify-center">
            <NPopover
              trigger="click"
              v-model:show="searchPopoverShow"
              @update:show="getSearchHotResult"
            >
              <template #trigger>
                <NInput
                  v-model:value="searchKeyword"
                  :placeholder="searchDefault"
                  style="width: 300px"
                  size="small"
                  clearable
                  @keydown.enter.stop="handleSearchItemClick(searchKeyword)"
                >
                  <template #prefix>
                    <NIcon :size="16">
                      <Search />
                    </NIcon>
                  </template>
                </NInput>
              </template>
              <div class="w-[274px] h-[300px] overflow-hidden">
                <NScrollbar content-class="h-[300px]">
                  <div
                    v-if="loading"
                    class="flex items-center justify-center h-full"
                  >
                    <NSpin :size="20" />
                  </div>
                  <div v-else>
                    <NList
                      v-if="!searchKeyword"
                      hoverable
                      :show-divider="false"
                      size="small"
                    >
                      <NListItem
                        class="cursor-pointer"
                        v-for="(item, index) in searchHot"
                        :key="item"
                        @click="handleSearchItemClick(item)"
                      >
                        <template #prefix>
                          <div
                            class="w-[20px]"
                            :style="{ color: getIndexColor(index) }"
                          >
                            {{ index + 1 }}
                          </div>
                        </template>
                        <div>
                          {{ item }}
                        </div>
                      </NListItem>
                    </NList>
                    <NList
                      v-else
                      hoverable
                      :show-divider="false"
                      size="small"
                      v-for="suggest in searchSuggest"
                      :key="suggest.LableName"
                    >
                      <template #header>
                        {{ suggest.LableName || '综合' }}
                      </template>
                      <NListItem
                        class="cursor-pointer"
                        v-for="(item, index) in suggest.RecordDatas"
                        :key="item.HintInfo"
                        @click="handleSearchItemClick(item.HintInfo)"
                      >
                        <template #prefix>
                          <div
                            class="w-[20px]"
                            :style="{ color: getIndexColor(index) }"
                          >
                            {{ index + 1 }}
                          </div>
                        </template>
                        <template #suffix>
                          <div class="flex items-center space-x-1">
                            <NIcon
                              :size="12"
                              :color="getIndexColor(index)"
                            >
                              <WhatshotTwotone />
                            </NIcon>
                            <NEllipsis class="w-[50px]">
                              {{ item.Hot }}
                            </NEllipsis>
                          </div>
                        </template>
                        <NEllipsis class="w-[150px]">
                          {{ item.HintInfo }}
                        </NEllipsis>
                      </NListItem>
                    </NList>
                  </div>
                </NScrollbar>
              </div>
            </NPopover>
          </div>
        </div>
      </div>
      <div class="no-drag flex justify-center">
        <NDropdown
          trigger="click"
          size="small"
          :options="menuOptions"
          @select="handleSelect"
        >
          <NTag
            class="cursor-pointer"
            round
            :bordered="false"
          >
            <template #avatar>
              <NAvatar
                round
                :size="25"
                :src="userStore.isAuthenticated ? userStore.pic : undefined"
              />
            </template>
            {{ userStore.isAuthenticated ? userStore.nickname : '未登录' }}
          </NTag>
        </NDropdown>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import {
  NAvatar,
  NButton,
  NDropdown,
  NEllipsis,
  NIcon,
  NInput,
  NList,
  NListItem,
  NPopover,
  NScrollbar,
  NSpin,
  NTag,
} from 'naive-ui';
import {
  ArrowBackCircleOutline,
  ArrowForwardCircleOutline,
  RefreshCircleOutline,
  Search,
} from '@vicons/ionicons5';
import { WhatshotTwotone } from '@vicons/material';
import { useRouter } from 'vue-router';
import { usePlayerStore, useUserStore } from '@/store';
import { getSearchDefault, getSearchHot, getSearchSuggest } from '@/api';
import { useGradientColor } from '@/hooks';
import { debounce } from 'lodash-es';
import player from '@/utils/player';

const router = useRouter();
const userStore = useUserStore();
const playerStore = usePlayerStore();

// 刷新当前页面
const refreshCurrentPage = () => {
  // 获取当前路由
  const currentRoute = router.currentRoute.value;

  // 使用路由参数变化来触发组件重新渲染，而不刷新整个页面
  const timestamp = Date.now();
  router.replace({
    path: currentRoute.path,
    query: { ...currentRoute.query, _t: timestamp },
  });
};

const { currentColor, getNextColor } = useGradientColor({
  steps: 5,
  lightColors: {
    start: '#EA0E0E',
    end: '#EB987E',
  },
  darkColors: {
    start: '#EA0E0E',
    end: '#EB987E',
  },
});

const loading = ref(false);

const searchPopoverShow = ref(false);
const searchKeyword = ref('');
const searchDefault = ref('搜索音乐、专辑、歌手、歌词');
const searchDefaultKeywords = ref<string[]>([]);
const searchHot = ref<string[]>([]);
const searchSuggest = ref<
  [
    {
      LableName: string;
      RecordDatas: [
        {
          HintInfo: string;
          Hot: string;
        },
      ];
    },
  ]
>();

// 搜索词轮换相关
const placeholderTimer = ref<NodeJS.Timeout | null>(null);
const currentPlaceholderIndex = ref(0);

// 默认搜索词
const predefinedKeywords = ref(['流行', '摇滚', '电音', '爵士', '古典']);

// 开始搜索词轮换
const startPlaceholderRotation = () => {
  if (placeholderTimer.value) {
    clearInterval(placeholderTimer.value);
  }

  placeholderTimer.value = setInterval(() => {
    // 只有在搜索框没有内容时才轮换
    if (!searchKeyword.value) {
      currentPlaceholderIndex.value =
        (currentPlaceholderIndex.value + 1) % predefinedKeywords.value.length;
      searchDefault.value = predefinedKeywords.value[currentPlaceholderIndex.value];
    }
  }, 30000); // 30秒轮换一次
};

// 停止搜索词轮换
const stopPlaceholderRotation = () => {
  if (placeholderTimer.value) {
    clearInterval(placeholderTimer.value);
    placeholderTimer.value = null;
  }
};

// 重置搜索词轮换
const resetPlaceholderRotation = () => {
  if (!searchKeyword.value) {
    // 从服务器获取的关键词优先，如果没有则使用预设关键词
    const keywords =
      searchDefaultKeywords.value.length > 0
        ? searchDefaultKeywords.value
        : predefinedKeywords.value;
    currentPlaceholderIndex.value = 0;
    searchDefault.value = keywords[0];
    startPlaceholderRotation();
  }
};

const generateIndexColor = () => {
  const colors = [];
  for (let i = 0; i < 5; i++) {
    if (i === 0) {
      colors.push(currentColor.value);
    } else {
      colors.push(getNextColor());
    }
  }
  return colors;
};

const indexColors = ref<string[]>(generateIndexColor());

const getIndexColor = (index: number) => {
  if (index <= indexColors.value.length - 1) {
    return indexColors.value[index];
  }
  return undefined;
};

const menuOptions = computed(() => {
  if (userStore.isAuthenticated) {
    return [
      {
        label: '个人中心',
        key: 'profile',
      },
      {
        label: '偏好设置',
        key: 'setting',
      },
      {
        type: 'divider',
        key: 'd1',
      },
      {
        label: '退出登录',
        key: 'logout',
      },
    ];
  }
  return [
    {
      label: '偏好设置',
      key: 'setting',
    },
    {
      type: 'divider',
      key: 'd1',
    },
    {
      label: '立即登录',
      key: 'login',
    },
  ];
});

const handleSelect = (key: string) => {
  if (key === 'login') {
    router.push('/login');
  }
  if (key === 'profile') {
    router.push('/profile');
  }
  if (key === 'setting') {
    router.push('/setting');
  }
  if (key === 'logout') {
    logout();
  }
};

const logout = () => {
  window.$dialog.warning({
    title: '退出登录',
    content: '确定要退出登录吗？',
    positiveText: '确定',
    negativeText: '取消',
    onPositiveClick: async () => {
      await player.pause();
      userStore.clearUserInfo();
      playerStore.clearPlaylist();
      playerStore.resetPlaybackState();
      router.push({
        path: '/home',
        replace: true,
      });
    },
  });
};

const getDefaultSearchKeyword = async () => {
  try {
    const res = await getSearchDefault();
    const serverKeywords =
      res.fallback?.map((item: { main_title: string }) => item.main_title) || [];

    if (serverKeywords.length > 0) {
      searchDefaultKeywords.value = serverKeywords;
      // 合并服务器关键词和预设关键词，服务器关键词优先
      const combinedKeywords = [...serverKeywords, ...predefinedKeywords.value];
      // 更新预设关键词数组为合并后的数组，最多30个
      predefinedKeywords.value = combinedKeywords.slice(0, 30);
    }

    // 设置初始搜索词并开始轮换
    currentPlaceholderIndex.value = 0;
    searchDefault.value = predefinedKeywords.value[0];
    startPlaceholderRotation();
  } catch (error) {
    console.error('获取默认搜索词失败:', error);
    // 失败时使用预设关键词
    searchDefault.value = predefinedKeywords.value[0];
    startPlaceholderRotation();
  }
};

// 先定义防抖后的函数
const debouncedFetchSearchHot = debounce(async () => {
  const res = await getSearchHot();
  const data = res.list?.[0]?.keywords?.map((item: { keyword: string }) => item.keyword) || [];
  searchHot.value = data;
  loading.value = false;
}, 500);

const getSearchHotResult = async (show: boolean) => {
  if (show && searchHot.value?.length === 0) {
    loading.value = true;
    await debouncedFetchSearchHot();
  }
};

// 定义搜索建议的防抖函数
const debouncedGetSearchSuggest = debounce(async (keyword: string) => {
  const res = await getSearchSuggest(keyword);
  searchSuggest.value = res;
  loading.value = false;
}, 500);

const getSearchSuggestResult = async () => {
  if (!searchKeyword.value) {
    return;
  }
  loading.value = true;
  await debouncedGetSearchSuggest(searchKeyword.value);
};

const handleSearchItemClick = async (keyword: string) => {
  if (!keyword) {
    keyword = searchDefault.value;
  }
  await router.push({
    path: '/search',
    query: {
      keyword,
      t: new Date().getTime(),
    },
  });
  searchPopoverShow.value = false;
  searchKeyword.value = '';
};

watch(
  () => searchKeyword.value,
  async newValue => {
    if (!newValue) {
      // 搜索框为空时，恢复轮换定时器
      resetPlaceholderRotation();
    } else {
      // 搜索框有内容时，停止轮换定时器
      stopPlaceholderRotation();
      // 获取搜索建议 需要防抖
      await getSearchSuggestResult();
    }
  },
);

onMounted(async () => {
  await getDefaultSearchKeyword();
});

onUnmounted(() => {
  // 清理定时器，防止内存泄漏
  stopPlaceholderRotation();
});
</script>

<style lang="scss" scoped>
.titlebar {
  height: 50px;
}

.content {
  padding: 0 10px;
  height: 50px;
}

.drag {
  app-region: drag;
  -webkit-app-region: drag;
}

.no-drag {
  app-region: no-drag;
  -webkit-app-region: no-drag;
}

.nav {
  margin-left: 280px;
}

:deep(.n-list) {
  font-size: 12px;
  .n-list__header {
    padding: 5px 0;
  }
  .n-list-item {
    padding: 5px 10px;
  }
  .n-list-item__suffix {
    margin-left: 10px;
  }
}
</style>
