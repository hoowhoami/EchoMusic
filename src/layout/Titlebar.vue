<template>
  <div class="titlebar drag">
    <NFlex
      class="content"
      align="center"
      justify="space-between"
    >
      <div class="no-drag nav">
        <NFlex align="center">
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
              @update:show="getSearchHotResult"
            >
              <template #trigger>
                <NInput
                  v-model:value="searchKeyword"
                  :placeholder="searchDefault"
                  style="width: 300px"
                  size="small"
                  clearable
                >
                  <template #prefix>
                    <NIcon :size="20">
                      <Search />
                    </NIcon>
                  </template>
                </NInput>
              </template>
              <div class="w-[274px] h-[300px] overflow-hidden">
                <NScrollbar content-class="h-[300px]">
                  <NList
                    v-if="!searchKeyword"
                    hoverable
                    :show-divider="false"
                    size="small"
                  >
                    <NListItem
                      v-for="(item, index) in searchHot"
                      :key="item"
                    >
                      <template #prefix>
                        <div class="w-[20px]">
                          {{ index + 1 }}
                        </div>
                      </template>
                      <div>
                        {{ item }}
                      </div>
                    </NListItem>
                  </NList>
                  <div v-else>
                    <NList
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
                        v-for="(item, index) in suggest.RecordDatas"
                        :key="item.HintInfo"
                      >
                        <template #prefix>
                          <div class="w-[20px]">
                            {{ index + 1 }}
                          </div>
                        </template>
                        <template #suffix>
                          <NEllipsis class="w-[50px]">
                            {{ item.Hot }}
                          </NEllipsis>
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
        </NFlex>
      </div>
      <div class="no-drag flex justify-center">
        <NDropdown
          trigger="click"
          size="small"
          :options="menuOptions"
          @select="handleSelect"
        >
          <NAvatar
            v-if="userStore.isAuthenticated"
            class="cursor-pointer"
            round
            :size="25"
            :src="userStore.pic"
          />
          <NAvatar
            v-else
            class="cursor-pointer"
            round
            :size="25"
          >
            未登录
          </NAvatar>
        </NDropdown>
      </div>
    </NFlex>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import {
  NAvatar,
  NButton,
  NDropdown,
  NEllipsis,
  NFlex,
  NIcon,
  NInput,
  NList,
  NListItem,
  NPopover,
  NScrollbar,
} from 'naive-ui';
import {
  ArrowBackCircleOutline,
  ArrowForwardCircleOutline,
  RefreshCircleOutline,
  Search,
} from '@vicons/ionicons5';
import { useRouter } from 'vue-router';
import { useUserStore } from '@/store';
import { getSearchDefault, getSearchHot, getSearchSuggest } from '@/api';

const router = useRouter();
const userStore = useUserStore();

const searchKeyword = ref('');
const searchDefault = ref('搜索音乐、专辑、歌手、歌词');
const searchDefaultKeywords = ref<string[]>([]);
const searchHot = ref<[]>([]);
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

const menuOptions = computed(() => {
  if (userStore.isAuthenticated) {
    return [
      {
        label: '个人中心',
        key: 'profile',
      },
      {
        label: '设置',
        key: 'setting',
      },
      {
        type: 'divider',
        key: 'd1',
      },
      {
        label: '退出',
        key: 'logout',
      },
    ];
  }
  return [
    {
      label: '设置',
      key: 'setting',
    },
    {
      type: 'divider',
      key: 'd1',
    },
    {
      label: '登录',
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
    onPositiveClick: () => {
      userStore.clearUserInfo();
    },
  });
};

const getDefaultSearchKeyword = () => {
  getSearchDefault().then(res => {
    searchDefaultKeywords.value =
      res.fallback?.map((item: { main_title: string }) => item.main_title) ||
      searchDefaultKeywords.value;
    searchDefault.value = searchDefaultKeywords.value[0];
  });
};

const getSearchHotResult = (show: boolean) => {
  if (show && searchHot.value.length === 0) {
    getSearchHot().then(res => {
      searchHot.value =
        res.list?.[0]?.keywords?.map((item: { keyword: string }) => item.keyword) ||
        searchHot.value;
    });
  }
};

const getSearchSuggestResult = () => {
  // 获取搜索建议
  getSearchSuggest(searchKeyword.value).then(res => {
    console.log(res);
    searchSuggest.value = res;
  });
};

watch(
  () => searchKeyword.value,
  newValue => {
    if (!newValue) {
      getDefaultSearchKeyword();
    } else {
      // 获取搜索建议 需要防抖
      getSearchSuggestResult();
    }
  },
);

onMounted(() => {
  getDefaultSearchKeyword();
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
}
</style>
