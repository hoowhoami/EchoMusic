<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { usePlayerStore } from '@/stores/player';
import { resumeRecordForScope } from '@/stores/player/resume';
import { usePlaylistStore } from '@/stores/playlist';
import { useUserStore } from '@/stores/user';
import { useToastStore } from '@/stores/toast';
import Button from '@/components/ui/Button.vue';
import Dialog from '@/components/ui/Dialog.vue';
import ResumeBatchDrawer from '@/components/music/ResumeBatchDrawer.vue';
import ContextMenuPanel from '@/components/music/ContextMenuPanel.vue';
import { copyShareTarget, createShareTarget } from '@/utils/share';
import { requestResumeHintPlay } from '@/utils/resumeHint';
import type { ShareTarget } from '../../../shared/share';
import type { ResumeKind, ResumeRow } from '@/components/music/resumeScopeTypes';
import { followArtist, unfollowArtist } from '@/api/artist';
import { getPlaylistDetail } from '@/api/playlist';
import type { PlaylistMeta } from '@/models/playlist';
import { mapPlaylistMeta } from '@/utils/mappers';
import { formatDuration } from '@/utils/format';
import { resolvePlaylistRoute } from '@/utils/playlistRoute';
import {
  iconChevronUpDown,
  iconClock,
  iconHeart,
  iconHeartFilled,
  iconMusic,
  iconSortDown,
  iconSortUp,
} from '@/icons';

type SortKey = 'index' | 'name' | 'time';
type SortOrder = 'asc' | 'desc' | null;

const props = defineProps<{ kind: ResumeKind; searchQuery?: string }>();

const KIND_LABEL: Record<ResumeKind, string> = {
  album: '专辑',
  audiobook: '有声',
  artist: '歌手',
  playlist: '歌单',
};

const GRID_TEMPLATE = '40px 58px minmax(0, 1fr) 40px 142px 104px 96px';

const EMPTY_TEXT: Record<ResumeKind, { title: string; caption: string }> = {
  album: { title: '暂无专辑续播', caption: '在专辑页播放过的内容会展示在这里' },
  audiobook: {
    title: '暂无有声续播',
    caption: '在有声页播放过的内容会展示在这里',
  },
  artist: {
    title: '暂无歌手续播',
    caption: '在歌手页播放过的内容会展示在这里',
  },
  playlist: {
    title: '暂无歌单续播',
    caption: '在歌单页播放过的内容会展示在这里',
  },
};

const router = useRouter();
const playerStore = usePlayerStore();
const playlistStore = usePlaylistStore();
const userStore = useUserStore();
const toastStore = useToastStore();

/** 有声章节名里带「第 19 集」这种集数时只留集数，其余照抄章节名。 */
const EPISODE_PATTERN = /第\s*[0-9零一二三四五六七八九十百千]+\s*[集节章回]/;

const buildHint = (title: string, kind: ResumeKind): string => {
  const text = title.trim();
  if (!text) return '—';
  if (kind === 'audiobook') {
    const matched = text.match(EPISODE_PATTERN);
    if (matched) return matched[0].replace(/\s+/g, ' ');
  }
  return text;
};

const rows = computed<ResumeRow[]>(() =>
  playerStore.resumeScopes
    .map((scope): ResumeRow | null => {
      if (scope.kind !== props.kind) return null;
      const record = resumeRecordForScope(playerStore.$state, scope);
      if (!record || record.position <= 0) return null;
      return {
        key: `${scope.kind}:${scope.id}`,
        id: String(scope.id),
        trackId: scope.trackId ?? '',
        name: scope.name || '未命名',
        cover: scope.cover ?? '',
        hint: buildHint(record.title ?? '', props.kind),
        searchText: record.title ?? '',
        position: record.position,
        duration: record.duration,
        updatedAt: scope.updatedAt || record.updatedAt,
        routeId: scope.routeId,
        routeType: scope.routeType,
      };
    })
    .filter((row): row is ResumeRow => row !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt),
);

const sortField = ref<SortKey | null>(null);
const sortOrder = ref<SortOrder>(null);

const handleSort = (field: SortKey) => {
  if (sortField.value === field) {
    if (sortOrder.value === 'asc') {
      sortOrder.value = 'desc';
    } else if (sortOrder.value === 'desc') {
      sortField.value = null;
      sortOrder.value = null;
    }
  } else {
    sortField.value = field;
    sortOrder.value = 'asc';
  }
};

const sortIcon = (field: SortKey) => {
  if (sortField.value !== field) return iconChevronUpDown;
  return sortOrder.value === 'desc' ? iconSortDown : iconSortUp;
};

const isSorting = (field: SortKey) => sortField.value === field;

const displayRows = computed<ResumeRow[]>(() => {
  const list = rows.value.slice();
  const field = sortField.value;
  const order = sortOrder.value;
  if (!field || !order) return list;
  const direction = order === 'asc' ? 1 : -1;
  if (field === 'name')
    return list.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN') * direction);
  if (field === 'time') return list.sort((a, b) => (a.updatedAt - b.updatedAt) * direction);
  return direction === 1 ? list : list.reverse();
});

/** 搜索框做小写、去标点与空白的包含比对，「夜的命名术」也能搜到「夜的命名术」这种带符号的写法。 */
const normalizeKeyword = (value: string): string => value.toLowerCase().replace(/[\s\p{P}]/gu, '');

const matchesKeyword = (row: ResumeRow, keyword: string): boolean => {
  const target = normalizeKeyword(keyword);
  if (!target) return true;
  return [row.name, row.searchText, row.hint].some((text) =>
    normalizeKeyword(text).includes(target),
  );
};

const filteredRows = computed<ResumeRow[]>(() =>
  displayRows.value.filter((row) => matchesKeyword(row, props.searchQuery ?? '')),
);

const now = ref(Date.now());
let nowTimer: ReturnType<typeof setInterval> | null = null;

const formatRelative = (timestamp: number): string => {
  const diff = Math.max(0, now.value - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return '刚刚';
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 2 * day) return '昨天';
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  const date = new Date(timestamp);
  return `${date.getMonth() + 1}-${date.getDate()}`;
};

/** 已收藏的专辑：用户自建/收藏歌单里 source=2 且 listid 指向该专辑。 */
const favoritedAlbumIds = computed(() => {
  const ids = new Set<string>();
  playlistStore.userPlaylists.forEach((entry) => {
    if (entry.source !== 2) return;
    [
      entry.id,
      entry.listid,
      entry.listCreateListid,
      entry.globalCollectionId,
      entry.listCreateGid,
    ].forEach((value) => {
      if (value !== undefined && value !== null && String(value) !== '') ids.add(String(value));
    });
  });
  return ids;
});

/** 已收藏的歌单：用户库里不是专辑收藏（source !== 2）、又不是自己建的那些。 */
const favoritedPlaylistIds = computed(() => {
  const ids = new Set<string>();
  const currentUserId = userStore.info?.userid;
  playlistStore.userPlaylists.forEach((entry) => {
    if (entry.source === 2) return;
    if (currentUserId && entry.listCreateUserid === currentUserId) return;
    [
      entry.id,
      entry.listid,
      entry.listCreateListid,
      entry.globalCollectionId,
      entry.listCreateGid,
    ].forEach((value) => {
      if (value !== undefined && value !== null && String(value) !== '') ids.add(String(value));
    });
  });
  return ids;
});

const togglingKey = ref<string | null>(null);

/**
 * 点下去就按意图先上色的临时状态：真正的收藏数据要等接口（收藏专辑/歌单还要整份重拉用户歌单）回来才变。
 * 歌手那条本来就是本地改状态所以即时，专辑/有声/歌单慢就慢在这里。
 */
const favoriteOverrides = reactive(new Map<string, boolean>());

const clearFavoriteOverride = (key: string) => {
  favoriteOverrides.delete(key);
};

const isFavorite = (row: ResumeRow): boolean => {
  const override = favoriteOverrides.get(row.key);
  if (override !== undefined) return override;
  if (props.kind === 'artist') return userStore.isArtistFollowed(row.id);
  if (props.kind === 'playlist') return favoritedPlaylistIds.value.has(row.id);
  return favoritedAlbumIds.value.has(row.id);
};

/** 歌单详情只在第一次收藏时拉，同一份 meta 反复收藏/取消就不用再等那次请求。 */
const playlistMetaCache = new Map<string, PlaylistMeta>();

/** 歌单桶的 collection 串：桶上存过就直接用，老桶没存过就按用户歌单列表反查。 */
const resolvePlaylistTarget = (row: ResumeRow): { id: string; type: string | null } => {
  if (row.routeId) return { id: row.routeId, type: row.routeType ?? null };
  const target = resolvePlaylistRoute(row.id, playlistStore.userPlaylists, userStore.info?.userid);
  return { id: target.id, type: target.type ?? null };
};

const resolvePlaylistDetailId = (row: ResumeRow): string => resolvePlaylistTarget(row).id;

const isRequestSuccessful = (payload: unknown): boolean => {
  if (!payload || typeof payload !== 'object') return false;
  const record = payload as Record<string, unknown>;
  return record.status === 1 || record.code === 200 || record.error_code === 0;
};

/** 收藏/关注的叫法：歌手叫关注，专辑、有声、歌单叫收藏。 */
const favoriteText = computed(() => {
  if (props.kind === 'artist') return { add: '关注', remove: '取消关注' };
  return { add: '收藏', remove: '取消收藏' };
});

/** 真正落库的那一步：成功返回 true，失败返回 false。提示交给调用方，批量时就不会一行一条弹个不停。 */
const applyFavorite = async (row: ResumeRow, next: boolean): Promise<boolean> => {
  try {
    if (props.kind === 'artist') {
      const response = next ? await followArtist(row.id) : await unfollowArtist(row.id);
      if (!isRequestSuccessful(response)) return false;
      if (next) userStore.addFollowedArtist(row.id);
      else userStore.removeFollowedArtist(row.id);
      return true;
    }
    if (props.kind === 'playlist') {
      // 收藏歌单要完整的 meta（创建者、列表 id 都在里面）；
      // 详情接口只认 collection 串（桶 id 是歌单自己的数字 id），所以先换算路由 id
      const detailId = resolvePlaylistDetailId(row);
      let meta = playlistMetaCache.get(detailId) ?? null;
      if (!meta) {
        const response = await getPlaylistDetail(detailId);
        const raw = response?.data?.[0];
        meta = raw ? mapPlaylistMeta(raw) : null;
        if (!meta || !isRequestSuccessful(response)) return false;
        playlistMetaCache.set(detailId, meta);
      }
      return next
        ? await playlistStore.favoritePlaylist(meta, userStore.info?.userid)
        : await playlistStore.unfavoritePlaylist(meta, userStore.info?.userid);
    }
    return next
      ? await playlistStore.favoriteAlbum({ id: row.id, name: row.name })
      : await playlistStore.unfavoriteAlbum(row.id);
  } catch {
    return false;
  }
};

const toggleFavorite = async (row: ResumeRow) => {
  if (togglingKey.value === row.key) return;
  if (!userStore.isLoggedIn) {
    toastStore.loginRequired(props.kind === 'artist' ? '关注歌手' : favoriteText.value.add);
    return;
  }
  const favorite = isFavorite(row);
  togglingKey.value = row.key;
  favoriteOverrides.set(row.key, !favorite);
  const done = await applyFavorite(row, !favorite);
  togglingKey.value = null;
  clearFavoriteOverride(row.key);
  if (!done) {
    toastStore.actionFailed(favorite ? favoriteText.value.remove : favoriteText.value.add);
    return;
  }
  if (favorite) toastStore.actionCompleted(`已${favoriteText.value.remove}`);
  else toastStore.actionSucceeded(favoriteText.value.add);
};

const rootRef = ref<HTMLElement | null>(null);
const showBatchDrawer = ref(false);
const showClearDialog = ref(false);

const openBatch = () => {
  showBatchDrawer.value = true;
};

const removeRows = (targets: ResumeRow[]) => {
  targets.forEach((row) => playerStore.forgetResumeScope(props.kind, row.id));
};

const openClearDialog = () => {
  showClearDialog.value = true;
};

const confirmClear = () => {
  const targets = rows.value.slice();
  removeRows(targets);
  showClearDialog.value = false;
  toastStore.actionCompleted(`已清空${KIND_LABEL[props.kind]}续播记录`);
};

/** 定位当前播放：只滚到那一行，不闪不跳（本来就已经高亮着）。 */
const locateCurrent = () => {
  const currentId = String(playerStore.currentTrackId ?? '');
  const row = currentId ? rows.value.find((item) => item.trackId === currentId) : null;
  const element = row
    ? rootRef.value?.querySelector<HTMLElement>(`[data-resume-key="${row.key}"]`)
    : null;
  if (!element) {
    toastStore.info(row ? '这条记录被当前搜索条件过滤掉了' : '当前播放不在本列表');
    return;
  }
  element.scrollIntoView({ block: 'center', behavior: 'smooth' });
};

const openRow = (row: ResumeRow) => {
  // 统一走「续播请求」：落地页收到就自己滚到那一行、高亮，播不播看「定位后自动续播」
  requestResumeHintPlay(row.key);
  if (props.kind === 'playlist') {
    // 桶里记的是歌单自己的 id，路由要的是 collection 串，得先换算再加 type
    const target = resolvePlaylistTarget(row);
    void router.push({
      name: 'playlist-detail',
      params: { id: target.id },
      query: target.type ? { type: target.type } : {},
    });
    return;
  }
  if (props.kind === 'artist') {
    void router.push({ name: 'artist-detail', params: { id: row.id } });
    return;
  }
  void router.push({
    name: 'album-detail',
    params: { id: row.id },
    query: props.kind === 'audiobook' ? { category: '2' } : {},
  });
};

// ── 右键菜单（外壳复用 ContextMenuPanel，类名沿用 song-context-*） ──

const contextMenuOpen = ref(false);
const contextMenuRow = ref<ResumeRow | null>(null);
const contextMenuPoint = ref({ x: 0, y: 0 });

const contextMenuFavoriteLabel = computed(() => {
  const row = contextMenuRow.value;
  if (!row) return favoriteText.value.add;
  return isFavorite(row) ? favoriteText.value.remove : favoriteText.value.add;
});

const openContextMenu = (event: MouseEvent, row: ResumeRow) => {
  event.preventDefault();
  contextMenuPoint.value = { x: event.clientX, y: event.clientY };
  contextMenuRow.value = row;
  contextMenuOpen.value = true;
};

const closeContextMenu = () => {
  contextMenuOpen.value = false;
};

const handleContextMenuAction = (action: () => void | Promise<void>) => {
  closeContextMenu();
  void action();
};

/**
 * 分享目标：歌单要换成 collection 串；有声仍是专辑，只是带上 category=2。
 * label 只影响文案里的称呼（专辑/有声/歌手/歌单），链接类型不变。
 */
const createResumeShareTarget = (row: ResumeRow): ShareTarget | null => {
  const label = KIND_LABEL[props.kind];
  let target: ShareTarget | null = null;
  if (props.kind === 'playlist')
    target = createShareTarget('playlist', resolvePlaylistTarget(row).id, row.name);
  else if (props.kind === 'artist') target = createShareTarget('artist', row.id, row.name);
  else if (props.kind === 'audiobook')
    target = createShareTarget('album', row.id, row.name, { category: '2' });
  else target = createShareTarget('album', row.id, row.name);
  return target ? { ...target, label } : null;
};

const ctxPlay = () => {
  const row = contextMenuRow.value;
  if (row) openRow(row);
};

const ctxToggleFavorite = () => {
  const row = contextMenuRow.value;
  if (row) void toggleFavorite(row);
};

const ctxRemoveFromHistory = () => {
  const row = contextMenuRow.value;
  contextMenuRow.value = null;
  contextMenuOpen.value = false;
  if (!row) return;
  removeRows([row]);
  toastStore.actionCompleted('已移除续播记录');
};

const ctxShare = async () => {
  const row = contextMenuRow.value;
  if (!row) return;
  const target = createResumeShareTarget(row);
  if (!target) return;
  try {
    const copied = await copyShareTarget(target);
    if (copied) toastStore.actionCompleted('分享链接已复制');
    else toastStore.actionFailed('复制分享链接');
  } catch {
    toastStore.actionFailed('复制分享链接');
  }
};

const ctxCopyInfo = async () => {
  const row = contextMenuRow.value;
  const text = row?.name.trim() ?? '';
  if (!text) return;
  try {
    const copied = window.electron?.share?.copy
      ? await window.electron.share.copy(text)
      : await navigator.clipboard.writeText(text).then(() => true);
    if (copied) toastStore.actionCompleted(`${KIND_LABEL[props.kind]}信息已复制`);
    else toastStore.actionFailed('复制信息');
  } catch {
    toastStore.actionFailed('复制信息');
  }
};

onMounted(() => {
  nowTimer = setInterval(() => {
    now.value = Date.now();
  }, 60_000);
  if (props.kind === 'artist') {
    void userStore.ensureFollowedArtists();
    return;
  }
  if (userStore.isLoggedIn) void playlistStore.fetchUserPlaylists();
});

onUnmounted(() => {
  if (nowTimer !== null) clearInterval(nowTimer);
  nowTimer = null;
});

const emptyText = computed(() => EMPTY_TEXT[props.kind]);

const emptyState = computed(() => {
  if (rows.value.length > 0) return { title: '没有匹配的续播记录', caption: '换个关键词再试试' };
  return emptyText.value;
});

// 父组件（播放历史页）通过 ref 调这三个入口
defineExpose({ openBatch, locateCurrent, openClearDialog });
</script>

<template>
  <div ref="rootRef" class="resume-scope-table">
    <div class="resume-scope-header" :style="{ gridTemplateColumns: GRID_TEMPLATE }">
      <button
        type="button"
        class="resume-sort-choice resume-col-index"
        :class="{ 'is-active': isSorting('index') }"
        @click="handleSort('index')"
      >
        <span>#</span>
        <Icon class="resume-sort-icon" :icon="sortIcon('index')" />
      </button>
      <span aria-hidden="true"></span>
      <button
        type="button"
        class="resume-sort-choice"
        :class="{ 'is-active': isSorting('name') }"
        @click="handleSort('name')"
      >
        <span>名称</span>
        <Icon class="resume-sort-icon" :icon="sortIcon('name')" />
      </button>
      <span aria-hidden="true"></span>
      <span class="resume-col-label">上次听到</span>
      <span class="resume-col-label">播放位置</span>
      <button
        type="button"
        class="resume-sort-choice"
        :class="{ 'is-active': isSorting('time') }"
        @click="handleSort('time')"
      >
        <span>播放时间</span>
        <Icon class="resume-sort-icon" :icon="sortIcon('time')" />
      </button>
    </div>

    <div v-if="filteredRows.length === 0" class="resume-scope-empty">
      <div class="resume-empty-icon">
        <Icon :icon="iconClock" width="28" height="28" />
      </div>
      <div class="resume-empty-title">{{ emptyState.title }}</div>
      <div class="resume-empty-caption">{{ emptyState.caption }}</div>
    </div>

    <ul v-else class="resume-scope-rows">
      <li v-for="(row, index) in filteredRows" :key="row.key">
        <div
          class="resume-scope-row"
          tabindex="0"
          :aria-label="row.name"
          :data-resume-key="row.key"
          :style="{ gridTemplateColumns: GRID_TEMPLATE }"
          @contextmenu.prevent="openContextMenu($event, row)"
          @click="openRow(row)"
          @keydown.enter.self.prevent="openRow(row)"
          @keydown.space.self.prevent="openRow(row)"
        >
          <span class="resume-col-index">{{ index + 1 }}</span>
          <span class="resume-cover">
            <img v-if="row.cover" :src="row.cover" alt="" />
            <Icon v-else :icon="iconMusic" width="16" height="16" />
          </span>
          <span class="resume-name">{{ row.name }}</span>
          <span class="resume-fav">
            <button
              type="button"
              class="action-icon resume-fav-btn"
              :class="{ 'is-active': isFavorite(row) }"
              :aria-pressed="isFavorite(row)"
              :aria-label="
                isFavorite(row)
                  ? kind === 'artist'
                    ? '已关注'
                    : kind === 'playlist'
                      ? '已收藏歌单'
                      : '已收藏'
                  : kind === 'artist'
                    ? '关注'
                    : kind === 'playlist'
                      ? '收藏歌单'
                      : '收藏'
              "
              @click.stop="toggleFavorite(row)"
            >
              <Icon
                :icon="isFavorite(row) ? iconHeartFilled : iconHeart"
                width="16"
                height="16"
                class="text-red-500"
              />
            </button>
          </span>
          <span class="resume-hint">{{ row.hint }}</span>
          <span class="resume-position">
            {{ formatDuration(row.position) }} /
            {{ row.duration > 0 ? formatDuration(row.duration) : '—' }}
          </span>
          <span class="resume-time">{{ formatRelative(row.updatedAt) }}</span>
        </div>
      </li>
    </ul>

    <ContextMenuPanel
      :open="contextMenuOpen && Boolean(contextMenuRow)"
      :x="contextMenuPoint.x"
      :y="contextMenuPoint.y"
      @close="closeContextMenu"
    >
      <button
        type="button"
        class="song-context-item"
        role="menuitem"
        @click="handleContextMenuAction(ctxPlay)"
      >
        播放
      </button>
      <button
        type="button"
        class="song-context-item"
        role="menuitem"
        @click="handleContextMenuAction(ctxToggleFavorite)"
      >
        {{ contextMenuFavoriteLabel }}
      </button>
      <button
        type="button"
        class="song-context-item is-danger"
        role="menuitem"
        @click="handleContextMenuAction(ctxRemoveFromHistory)"
      >
        从播放历史中移除
      </button>
      <div class="song-context-separator"></div>
      <button
        type="button"
        class="song-context-item"
        role="menuitem"
        @click="handleContextMenuAction(ctxShare)"
      >
        分享
      </button>
      <button
        type="button"
        class="song-context-item"
        role="menuitem"
        @click="handleContextMenuAction(ctxCopyInfo)"
      >
        复制信息
      </button>
    </ContextMenuPanel>
    <ResumeBatchDrawer
      v-model:open="showBatchDrawer"
      :rows="filteredRows"
      :label="KIND_LABEL[kind]"
      :favorite-add="favoriteText.add"
      :favorite-remove="favoriteText.remove"
      :is-favorite="isFavorite"
      :apply-favorite="applyFavorite"
      :on-remove="removeRows"
    />

    <Dialog
      v-model:open="showClearDialog"
      :title="`清空${KIND_LABEL[kind]}续播`"
      :description="`确认清空${KIND_LABEL[kind]}的全部续播记录？此操作不可撤销。`"
    >
      <template #footer>
        <div class="flex justify-end gap-3">
          <Button
            variant="danger"
            size="default"
            :disabled="rows.length === 0"
            @click="confirmClear"
          >
            确认清空
          </Button>
          <Button variant="outline" size="default" @click="showClearDialog = false"> 取消 </Button>
        </div>
      </template>
    </Dialog>
  </div>
</template>

<style scoped>
.resume-scope-table {
  padding-bottom: 8px;
}

.resume-scope-header {
  display: grid;
  align-items: center;
  height: 44px;
  font-size: 12px;
  font-weight: 700;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border-subtle);
}

.resume-scope-header > *,
.resume-scope-row > * {
  min-width: 0;
}

.resume-sort-choice {
  justify-self: stretch;
  text-align: start;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0;
  background: transparent;
  border: 0;
  color: inherit;
  font: inherit;
  cursor: pointer;
  transition: color 0.16s ease;
}

.resume-sort-choice:hover,
.resume-sort-choice.is-active {
  color: var(--color-primary-text);
}

.resume-scope-header .resume-sort-choice:last-child {
  justify-self: stretch;
}

.resume-sort-icon {
  width: 14px;
  height: 14px;
  opacity: 0.62;
}

.resume-sort-choice.is-active .resume-sort-icon {
  opacity: 1;
}

.resume-col-index {
  padding-left: 8px;
}

.resume-scope-row .resume-col-index {
  font-size: 12px;
  color: var(--text-secondary);
}

.resume-col-label {
  justify-self: stretch;
  text-align: start;
}

.resume-scope-rows {
  margin: 0;
  padding: 0;
  list-style: none;
}

.resume-scope-row {
  display: grid;
  align-items: center;
  height: 60px;
  border-radius: 8px;
  cursor: pointer;
  transition: background-color 0.16s ease;
}

.resume-scope-row:hover,
.resume-scope-row:focus-visible {
  background: var(--row-hover-bg);
  outline: none;
}

.resume-cover {
  display: flex;
  align-items: center;
  justify-content: flex-start;
}

.resume-cover img {
  width: 46px;
  height: 46px;
  border-radius: var(--radius-media, 10px);
  object-fit: cover;
  display: block;
}

.resume-cover :deep(svg) {
  color: var(--text-secondary);
}

.resume-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-main);
}

.resume-fav {
  display: flex;
  align-items: center;
}

.resume-fav-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  background: transparent;
  border: 0;
  border-radius: 6px;
  cursor: pointer;
  opacity: 0.78;
  transition:
    opacity 0.16s ease,
    background-color 0.16s ease;
}

.resume-fav-btn:hover {
  opacity: 1;
  background: var(--row-hover-bg);
}

.resume-fav-btn.is-active {
  opacity: 1;
}

.resume-hint {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding-right: 12px;
  font-size: 13px;
  color: var(--text-secondary);
}

.resume-position {
  font-size: 12px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.resume-time {
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
}

.resume-scope-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 96px 0;
  text-align: center;
}

.resume-empty-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
  margin-bottom: 16px;
  border-radius: var(--radius-card, 16px);
  background: color-mix(in srgb, var(--primary, #22c55e) 12%, transparent);
  color: var(--primary-text, #22c55e);
}

.resume-empty-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-main);
}

.resume-empty-caption {
  margin-top: 8px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
}
</style>
