/** 用户歌单返回逗号分隔文本，详情也可能返回带名称的标签对象数组。 */
export function parsePlaylistTags(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  const tags = values.flatMap((item) => {
    const name =
      item && typeof item === 'object'
        ? ((item as Record<string, unknown>).name ?? (item as Record<string, unknown>).tag_name)
        : item;
    return typeof name === 'string' ? name.split(/[,，\r\n]+/) : [];
  });
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
}

export function serializePlaylistTags(value: unknown): string {
  return parsePlaylistTags(value).join(',');
}
