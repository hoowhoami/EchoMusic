/**
 * 卡片批量抽屉的选中集合。纯函数、无副作用：组件只管渲染与发请求，选中规则集中在这里便于测试。
 */

/** 某一行是否已被选中。 */
export const isKeySelected = (selected: string[], key: string): boolean => selected.includes(key);

/** 点一行：已选则取消，未选则追加（保持点击顺序，不重排已有选中项）。 */
export const toggleKey = (selected: string[], key: string): string[] =>
  isKeySelected(selected, key) ? selected.filter((item) => item !== key) : [...selected, key];

/** 是否全选：没有可选项时不算全选（按钮应保持未选中态）。 */
export const isAllSelected = (selected: string[], total: number): boolean =>
  total > 0 && selected.length === total;

/** 点全选：已经全选就清空，否则全选当前所有可选项。 */
export const toggleAllKeys = (selected: string[], allKeys: string[]): string[] =>
  isAllSelected(selected, allKeys.length) ? [] : [...allKeys];
