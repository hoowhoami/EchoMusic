import { computed, reactive } from 'vue';
import type { Song } from '@/models/song';

export interface SongContextMenuExtension {
  id: string;
  label: string;
  order: number;
  danger?: boolean;
  visible?: (song: Song) => boolean;
  enabled?: (song: Song) => boolean;
  onSelect: (song: Song) => void | Promise<void>;
}

const extensions = reactive<SongContextMenuExtension[]>([]);

const sortByOrder = (items: SongContextMenuExtension[]) =>
  items
    .slice()
    .sort(
      (left, right) =>
        left.order - right.order || left.label.localeCompare(right.label, 'zh-Hans-CN'),
    );

export const songContextMenuExtensions = computed(() => sortByOrder(extensions));

export const registerSongContextMenuExtension = (extension: SongContextMenuExtension) => {
  const id = String(extension.id || '').trim();
  if (!id) throw new Error('歌曲菜单扩展 id 不能为空');

  const item = {
    ...extension,
    id,
    order: Number(extension.order ?? 1000),
  };

  const existing = extensions.findIndex((entry) => entry.id === id);
  if (existing >= 0) extensions.splice(existing, 1, item);
  else extensions.push(item);

  return () => {
    const index = extensions.findIndex((entry) => entry.id === id);
    if (index >= 0) extensions.splice(index, 1);
  };
};
