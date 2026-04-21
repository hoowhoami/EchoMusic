export const SONG_LIST_INDEX_COL_WIDTH = 40;
export const SONG_LIST_ALBUM_COL_WIDTH = 142;
export const SONG_LIST_LYRIC_COL_WIDTH = 260;
export const SONG_LIST_DURATION_COL_WIDTH = 68;
export const SONG_LIST_TITLE_OFFSET_WITH_COVER = 58;

interface GridOptions {
  showIndex: boolean;
  showAlbum: boolean;
  showDuration: boolean;
  lyricColumn?: boolean;
}

export const buildSongListGridTemplate = ({
  showIndex,
  showAlbum,
  showDuration,
  lyricColumn,
}: GridOptions): string => {
  const columns: string[] = [];

  if (showIndex) {
    columns.push(`${SONG_LIST_INDEX_COL_WIDTH}px`);
  }

  columns.push('minmax(0, 1fr)');

  if (showAlbum) {
    columns.push(`${lyricColumn ? SONG_LIST_LYRIC_COL_WIDTH : SONG_LIST_ALBUM_COL_WIDTH}px`);
  }

  if (showDuration) {
    columns.push(`${SONG_LIST_DURATION_COL_WIDTH}px`);
  }

  return columns.join(' ');
};
