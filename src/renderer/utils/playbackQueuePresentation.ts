import type { PlaybackQueueState, PlaybackQueueType } from '@/stores/playlist/types';

const QUEUE_TYPE_LABELS: Record<PlaybackQueueType, string> = {
  default: '播放队列',
  'daily-recommend': '每日推荐',
  'home-discover': '刷歌',
  'style-recommend': '风格推荐',
  playlist: '歌单',
  ranking: '排行榜',
  album: '专辑',
  artist: '歌手',
  search: '搜索结果',
  history: '播放历史',
  cloud: '云盘音乐',
  fm: '私人 FM',
  'listen-together': '一起听',
  manual: '我的队列',
  purchased: '已购音乐',
};

type QueueIdentity = Pick<PlaybackQueueState, 'id' | 'type' | 'title' | 'subtitle'>;

export function getPlaybackQueuePresentation(queue: QueueIdentity | null | undefined) {
  if (!queue) return { title: '播放队列', subtitle: '', typeLabel: '' };
  const typeLabel = QUEUE_TYPE_LABELS[queue.type] ?? QUEUE_TYPE_LABELS.default;
  const title = queue.type === 'home-discover' ? '刷歌' : queue.title.trim() || typeLabel;
  let subtitle = '';
  // Only these sources have meaningful secondary information. Also covers saved legacy queues.
  if (
    ['album', 'playlist', 'search', 'style-recommend'].includes(queue.type) &&
    queue.id !== 'queue:favorites'
  ) {
    subtitle = queue.subtitle.trim();
  }
  if (
    subtitle === title ||
    subtitle === typeLabel ||
    (queue.type === 'style-recommend' && subtitle === '默认推荐') ||
    (queue.type === 'search' && subtitle === '歌曲搜索')
  )
    subtitle = '';
  return { title, subtitle, typeLabel };
}

export function getPlaybackQueueStatus(
  queue: Pick<PlaybackQueueState, 'id' | 'type'> | null | undefined,
  currentQueueId: string | null | undefined,
): string {
  if (!queue) return '';
  if (queue.id === currentQueueId) return '当前';
  return queue.type === 'manual' ? '待播' : '历史';
}
