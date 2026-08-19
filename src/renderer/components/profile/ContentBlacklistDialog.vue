<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue';
import type { BlacklistEntry, BlacklistLabel } from '@/api/blacklist';
import Button from '@/components/ui/Button.vue';
import CustomTabBar from '@/components/ui/CustomTabBar.vue';
import Dialog from '@/components/ui/Dialog.vue';
import Scrollbar from '@/components/ui/Scrollbar.vue';
import { iconEyeOff, iconHeartOff, iconRefreshCw, iconRotateCcw } from '@/icons';
import { useContentBlacklistStore } from '@/stores/contentBlacklist';
import { useToastStore } from '@/stores/toast';

interface Props {
  open?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  open: false,
});

const emit = defineEmits<{
  (event: 'update:open', value: boolean): void;
}>();

const blacklistStore = useContentBlacklistStore();
const toastStore = useToastStore();
const activeTab = ref<BlacklistLabel>('song');
const removingKey = ref('');
const pendingRemoval = ref<BlacklistEntry | null>(null);
const listScrollbar = ref<{ setScrollTop: (value: number) => void } | null>(null);
const tabIdPrefix = useId();
const tabIds = [`${tabIdPrefix}-song-tab`, `${tabIdPrefix}-singer-tab`];
const panelIds = [`${tabIdPrefix}-song-panel`, `${tabIdPrefix}-singer-panel`];

const open = computed({
  get: () => props.open,
  set: (value: boolean) => emit('update:open', value),
});
const bucket = computed(() => blacklistStore.buckets[activeTab.value]);
const hasMore = computed(() => blacklistStore.hasMore(activeTab.value));
const activeTabIndex = computed({
  get: () => (activeTab.value === 'song' ? 0 : 1),
  set: (value: number) => {
    activeTab.value = value === 1 ? 'singer' : 'song';
  },
});
const tabLabels = computed(() => [
  blacklistStore.song.loaded ? `不感兴趣 ${blacklistStore.song.total}` : '不感兴趣',
  blacklistStore.singer.loaded ? `已屏蔽歌手 ${blacklistStore.singer.total}` : '已屏蔽歌手',
]);
const activeTabId = computed(() => tabIds[activeTabIndex.value]);
const activePanelId = computed(() => panelIds[activeTabIndex.value]);
const activeMeta = computed(() =>
  activeTab.value === 'song'
    ? {
        title: '不感兴趣的歌曲',
        description: '这些歌曲及相似内容将减少出现在个性化推荐中。',
        empty: '还没有标记不感兴趣的歌曲',
        icon: iconHeartOff,
      }
    : {
        title: '已屏蔽的歌手',
        description: '屏蔽后，该歌手的内容将不再出现在个性化推荐中。',
        empty: '还没有屏蔽任何歌手',
        icon: iconEyeOff,
      },
);

const entryRequestKey = (entry: BlacklistEntry) => `${entry.label}:${entry.key}`;

const displayName = (entry: BlacklistEntry) => {
  const name = entry.name.trim();
  return name || (entry.label === 'song' ? '未命名歌曲' : '未命名歌手');
};

const removalDialogOpen = computed({
  get: () => pendingRemoval.value !== null,
  set: (value: boolean) => {
    if (!value && !removingKey.value) pendingRemoval.value = null;
  },
});
const removalTitle = computed(() =>
  pendingRemoval.value?.label === 'singer' ? '取消屏蔽歌手' : '撤销不感兴趣',
);
const removalDescription = computed(() => {
  const entry = pendingRemoval.value;
  if (!entry) return '';
  return entry.label === 'singer'
    ? `确定取消屏蔽“${displayName(entry)}”吗？该歌手的内容可能会再次出现在推荐中。`
    : `确定撤销对“${displayName(entry)}”的不感兴趣吗？这首歌可能会再次出现在推荐中。`;
});

const formatTime = (value: string) => {
  const text = value.trim();
  if (!text || text === '0') return '';

  const numeric = Number(text);
  const date =
    Number.isFinite(numeric) && /^\d+$/.test(text)
      ? new Date(text.length <= 10 ? numeric * 1000 : numeric)
      : new Date(text);
  if (Number.isNaN(date.getTime())) return '';

  const pad = (number: number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

const loadCurrentTab = async (refresh = false) => {
  if (bucket.value.loading) return;
  if (refresh || !bucket.value.loaded) await blacklistStore.refresh(activeTab.value);
};

const refreshCurrentTab = () => loadCurrentTab(true);

const loadMore = async () => {
  if (bucket.value.loading || !hasMore.value) return;
  await blacklistStore.loadNextPage(activeTab.value);
};

const requestRemoval = (entry: BlacklistEntry) => {
  if (!removingKey.value) pendingRemoval.value = entry;
};

const confirmRemoval = async () => {
  const entry = pendingRemoval.value;
  if (!entry || removingKey.value) return;

  removingKey.value = entryRequestKey(entry);
  try {
    const removed = await blacklistStore.remove(entry);
    if (removed) {
      toastStore.success(
        entry.label === 'song'
          ? `已撤销对“${displayName(entry)}”的不感兴趣`
          : `已取消屏蔽“${displayName(entry)}”`,
      );
      pendingRemoval.value = null;
    } else {
      toastStore.danger(
        blacklistStore.buckets[entry.label].error ||
          `${entry.label === 'song' ? '撤销' : '取消屏蔽'}失败，请稍后重试`,
      );
    }
  } finally {
    removingKey.value = '';
  }
};

watch(
  () => props.open,
  (isOpen) => {
    if (isOpen) {
      void nextTick(() => listScrollbar.value?.setScrollTop(0));
      void loadCurrentTab(true);
    } else if (!removingKey.value) {
      pendingRemoval.value = null;
    }
  },
  { immediate: true },
);

watch(activeTab, () => {
  void nextTick(() => listScrollbar.value?.setScrollTop(0));
  if (props.open) void loadCurrentTab();
});
</script>

<template>
  <Dialog
    v-model:open="open"
    title="黑名单管理"
    description="管理个性化推荐中不想看到的歌曲和歌手。"
    contentClass="content-blacklist-dialog"
    bodyClass="content-blacklist-dialog-body"
    :showClose="true"
    :noScroll="true"
    :flushBody="true"
  >
    <div class="blacklist-dialog-layout">
      <p class="blacklist-dialog-description">管理个性化推荐中不想看到的歌曲和歌手。</p>

      <div class="blacklist-tabs">
        <div class="blacklist-fixed-content">
          <CustomTabBar
            v-model="activeTabIndex"
            :tabs="tabLabels"
            :tab-ids="tabIds"
            :panel-ids="panelIds"
            aria-label="黑名单管理分类"
            class="blacklist-category-tabs"
          />
        </div>

        <div
          :id="activePanelId"
          class="blacklist-tab-panel"
          role="tabpanel"
          :aria-labelledby="activeTabId"
          tabindex="0"
        >
          <div class="blacklist-fixed-content">
            <div class="blacklist-toolbar">
              <div class="min-w-0">
                <h4 class="blacklist-section-title">{{ activeMeta.title }}</h4>
                <p class="blacklist-section-description">{{ activeMeta.description }}</p>
              </div>
              <Button
                variant="unstyled"
                size="none"
                class="blacklist-refresh-button"
                :disabled="bucket.loading || Boolean(removingKey)"
                :title="`刷新${activeMeta.title}`"
                :aria-label="`刷新${activeMeta.title}`"
                @click="refreshCurrentTab"
              >
                <Icon
                  :icon="iconRefreshCw"
                  width="15"
                  height="15"
                  :class="bucket.loading ? 'animate-spin' : ''"
                />
              </Button>
            </div>

            <div
              v-if="bucket.error && bucket.entries.length > 0"
              class="blacklist-error-banner"
              role="alert"
            >
              <span class="min-w-0 truncate">{{ bucket.error }}</span>
              <Button
                variant="ghost"
                size="xs"
                class="h-7 shrink-0 px-2 text-red-500"
                :disabled="bucket.loading"
                @click="refreshCurrentTab"
              >
                重试
              </Button>
            </div>
          </div>

          <Scrollbar
            ref="listScrollbar"
            class="blacklist-list-scroll"
            :content-props="{ class: 'blacklist-list-scroll-content' }"
          >
            <div class="blacklist-scroll-inner" :aria-busy="bucket.loading">
              <div
                v-if="bucket.loading && !bucket.loaded"
                class="blacklist-list-state text-text-main/45"
                role="status"
                aria-live="polite"
              >
                <Icon :icon="iconRefreshCw" width="22" height="22" class="animate-spin" />
                <span class="text-[12px] font-bold">正在加载</span>
              </div>

              <div
                v-else-if="bucket.error && bucket.entries.length === 0"
                class="blacklist-list-state px-6 text-center"
                role="alert"
              >
                <p class="text-[12px] font-bold text-red-500">{{ bucket.error }}</p>
                <Button
                  variant="outline"
                  size="sm"
                  class="mt-4"
                  :loading="bucket.loading"
                  @click="refreshCurrentTab"
                >
                  重新加载
                </Button>
              </div>

              <div
                v-else-if="bucket.entries.length === 0"
                class="blacklist-list-state text-center text-text-main/40"
                role="status"
              >
                <div class="blacklist-empty-icon">
                  <Icon :icon="activeMeta.icon" width="22" height="22" />
                </div>
                <p class="text-[12px] font-black">{{ activeMeta.empty }}</p>
                <p class="mt-1 text-[10px] font-medium text-text-main/30">
                  你可以随时在歌曲或歌手页面添加
                </p>
              </div>

              <template v-else>
                <div class="blacklist-entry-list">
                  <div
                    v-for="entry in bucket.entries"
                    :key="`${entry.label}:${entry.key}`"
                    class="blacklist-entry"
                  >
                    <div class="blacklist-entry-icon">
                      <Icon
                        :icon="entry.label === 'song' ? iconHeartOff : iconEyeOff"
                        width="17"
                        height="17"
                      />
                    </div>
                    <div class="min-w-0 flex-1">
                      <p class="truncate text-[12px] font-black" :title="displayName(entry)">
                        {{ displayName(entry) }}
                      </p>
                      <p
                        v-if="formatTime(entry.createdAt)"
                        class="mt-0.5 text-[10px] font-medium text-text-main/35"
                      >
                        {{ entry.label === 'song' ? '标记于' : '屏蔽于' }}
                        {{ formatTime(entry.createdAt) }}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="none"
                      class="blacklist-entry-action"
                      :disabled="bucket.loading || Boolean(removingKey)"
                      :title="
                        entry.label === 'song'
                          ? `撤销不感兴趣：${displayName(entry)}`
                          : `取消屏蔽：${displayName(entry)}`
                      "
                      :aria-label="
                        entry.label === 'song'
                          ? `撤销不感兴趣 ${displayName(entry)}`
                          : `取消屏蔽 ${displayName(entry)}`
                      "
                      @click="requestRemoval(entry)"
                    >
                      <Icon
                        :icon="
                          removingKey === entryRequestKey(entry) ? iconRefreshCw : iconRotateCcw
                        "
                        width="16"
                        height="16"
                        :class="removingKey === entryRequestKey(entry) ? 'animate-spin' : ''"
                      />
                    </Button>
                  </div>
                </div>

                <div v-if="hasMore" class="blacklist-list-footer">
                  <Button
                    variant="secondary"
                    size="sm"
                    :loading="bucket.loading"
                    :disabled="Boolean(removingKey)"
                    @click="loadMore"
                  >
                    加载更多
                  </Button>
                </div>
              </template>
            </div>
          </Scrollbar>
        </div>
      </div>
    </div>
  </Dialog>

  <Dialog
    v-model:open="removalDialogOpen"
    :title="removalTitle"
    :description="removalDescription"
    :closeOnEscape="!removingKey"
    :closeOnInteractOutside="!removingKey"
  >
    <template #footer>
      <Button
        variant="outline"
        size="sm"
        :disabled="Boolean(removingKey)"
        @click="pendingRemoval = null"
      >
        取消
      </Button>
      <Button size="sm" :loading="Boolean(removingKey)" @click="confirmRemoval">
        {{ pendingRemoval?.label === 'singer' ? '取消屏蔽' : '确认撤销' }}
      </Button>
    </template>
  </Dialog>
</template>

<style scoped>
@reference "@/style.css";

.blacklist-dialog-layout,
.blacklist-tabs,
.blacklist-tab-panel {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
}

.blacklist-dialog-description {
  padding-right: 24px;
  color: var(--color-text-secondary);
  font-size: 13px;
  line-height: 1.6;
}

.blacklist-fixed-content {
  flex: none;
  padding-right: 24px;
}

.blacklist-category-tabs {
  margin-top: 10px;
}

.blacklist-toolbar {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 0 10px;
}

.blacklist-section-title {
  color: var(--color-text-main);
  font-size: 13px;
  font-weight: 700;
}

.blacklist-section-description {
  margin-top: 2px;
  color: var(--color-text-secondary);
  font-size: 11px;
  font-weight: 500;
  line-height: 1.55;
  opacity: 0.72;
}

.blacklist-refresh-button {
  display: flex;
  width: 32px;
  height: 32px;
  flex: none;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  color: color-mix(in srgb, var(--color-text-main) 60%, transparent);
}

.blacklist-refresh-button:hover {
  color: var(--color-text-main);
  background: var(--control-hover-bg);
}

.blacklist-error-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  color: rgb(239 68 68);
  background: rgb(239 68 68 / 8%);
  font-size: 12px;
  font-weight: 700;
}

.blacklist-list-scroll {
  min-height: 0;
  flex: 1;
}

:global(.blacklist-list-scroll-content) {
  padding-right: 22px;
}

.blacklist-scroll-inner {
  display: flex;
  min-height: 100%;
  flex-direction: column;
  padding: 2px 0 4px;
}

.blacklist-list-state {
  display: flex;
  min-height: 240px;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
}

.blacklist-empty-icon {
  display: flex;
  width: 44px;
  height: 44px;
  margin-bottom: 2px;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  background: var(--control-muted-bg);
}

.blacklist-entry-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.blacklist-entry {
  display: flex;
  min-height: 56px;
  align-items: center;
  gap: 10px;
  padding: 7px 8px;
  border-radius: 8px;
  transition: background-color 160ms ease;
}

.blacklist-entry:hover {
  background: var(--control-hover-bg);
}

.blacklist-entry-icon {
  display: flex;
  width: 36px;
  height: 36px;
  flex: none;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  color: color-mix(in srgb, var(--color-text-main) 55%, transparent);
  background: var(--control-muted-bg);
}

.blacklist-entry-action {
  display: inline-flex;
  width: 36px;
  height: 36px;
  flex: none;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  color: color-mix(in srgb, var(--color-text-main) 60%, transparent);
}

.blacklist-entry-action:hover {
  color: var(--color-text-main);
}

.blacklist-list-footer {
  display: flex;
  min-height: 52px;
  align-items: center;
  justify-content: center;
  padding-top: 8px;
}

:global(.dialog-content.content-blacklist-dialog) {
  width: 500px;
  max-width: calc(100vw - 32px);
  height: min(540px, calc(100vh - 96px));
  max-height: calc(100vh - 96px);
}

:global(.dialog-content.content-blacklist-dialog .content-blacklist-dialog-body) {
  display: flex;
  min-height: 0;
  flex: 1;
  overflow: hidden;
  margin-top: 0;
}
</style>
