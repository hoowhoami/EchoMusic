export interface SidebarLayout {
  sectionOrder: string[];
  itemOrder: Record<string, string[]>;
  hiddenSections: Record<string, boolean>;
  hiddenItems: Record<string, boolean>;
  railSections: Record<string, boolean>;
}

export const emptySidebarLayout = (): SidebarLayout => ({
  sectionOrder: [],
  itemOrder: {},
  hiddenSections: {},
  hiddenItems: {},
  railSections: {},
});

export interface SidebarLayoutItem {
  key: string;
  id: string;
  title: string;
  order: number;
  lockedOrder?: boolean;
}

export interface SidebarLayoutSection<T extends SidebarLayoutItem = SidebarLayoutItem> {
  id: string;
  title: string;
  order: number;
  collapsible?: boolean;
  items: T[];
}

export type ResolvedSidebarLayoutItem<T extends SidebarLayoutItem = SidebarLayoutItem> = T & {
  isHidden: boolean;
  source: T;
};

export type ResolvedSidebarLayoutSection<T extends SidebarLayoutItem = SidebarLayoutItem> = Omit<
  SidebarLayoutSection<T>,
  'items'
> & {
  items: ResolvedSidebarLayoutItem<T>[];
  isHidden: boolean;
  isRailVisible: boolean;
  source: SidebarLayoutSection<T>;
};

interface ResolveSidebarLayoutOptions {
  includeHidden?: boolean;
}

const normalizedOrder = (keys: readonly string[] | undefined) =>
  new Map((Array.isArray(keys) ? keys : []).map((key, index) => [key, index]));

const sortBySavedOrder = <T extends { key?: string; id: string; order: number; title: string }>(
  items: readonly T[],
  saved: Map<string, number>,
) =>
  items.slice().sort((left, right) => {
    const leftKey = left.key ?? left.id;
    const rightKey = right.key ?? right.id;
    return (
      (saved.get(leftKey) ?? Infinity) - (saved.get(rightKey) ?? Infinity) ||
      left.order - right.order ||
      left.title.localeCompare(right.title, 'zh-Hans-CN')
    );
  });

export function resolveSidebarLayout<T extends SidebarLayoutItem>(
  sections: readonly SidebarLayoutSection<T>[],
  layout?: SidebarLayout,
  options: ResolveSidebarLayoutOptions = {},
): ResolvedSidebarLayoutSection<T>[] {
  const sectionOrder = normalizedOrder(layout?.sectionOrder);

  return sections
    .slice()
    .sort(
      (left, right) =>
        (sectionOrder.get(left.id) ?? Infinity) - (sectionOrder.get(right.id) ?? Infinity) ||
        left.order - right.order ||
        left.title.localeCompare(right.title, 'zh-Hans-CN'),
    )
    .map((section) => {
      const itemOrder = normalizedOrder(layout?.itemOrder?.[section.id]);
      const items = sortBySavedOrder(section.items, itemOrder)
        .map((item) => ({
          ...item,
          isHidden: layout?.hiddenItems?.[item.key] === true,
          source: item,
        }))
        .filter((item) => options.includeHidden || !item.isHidden);

      return {
        ...section,
        items,
        isHidden: layout?.hiddenSections?.[section.id] === true,
        isRailVisible: layout?.railSections?.[section.id] !== false,
        source: section,
      };
    })
    .filter((section) => options.includeHidden || (!section.isHidden && section.items.length > 0));
}

export function reorderSidebarSections(
  layout: SidebarLayout | undefined,
  sections: readonly { id: string }[],
  ids: string[],
): SidebarLayout {
  const active = new Set(sections.map((section) => section.id));
  const base = layout ?? emptySidebarLayout();
  if (new Set(ids).size !== ids.length || ids.some((id) => !active.has(id))) return base;

  const order = [...new Set(base.sectionOrder ?? [])];
  for (const section of sections) if (!order.includes(section.id)) order.push(section.id);
  const changed = new Set(ids);
  let index = 0;
  return {
    ...base,
    sectionOrder: order.map((id) => (changed.has(id) ? ids[index++] : id)),
  };
}

export function reorderSidebarItems(
  layout: SidebarLayout | undefined,
  sectionId: string,
  items: readonly { key: string; lockedOrder?: boolean }[],
  keys: string[],
): SidebarLayout {
  if (items.some((item) => item.lockedOrder)) return layout ?? emptySidebarLayout();
  const active = new Set(items.map((item) => item.key));
  const base = layout ?? emptySidebarLayout();
  if (new Set(keys).size !== keys.length || keys.some((key) => !active.has(key))) return base;

  const previous = base.itemOrder?.[sectionId] ?? [];
  const order = [...new Set(previous)];
  for (const item of items) if (!order.includes(item.key)) order.push(item.key);
  const changed = new Set(keys);
  let index = 0;
  return {
    ...base,
    itemOrder: {
      ...(base.itemOrder ?? {}),
      [sectionId]: order.map((key) => (changed.has(key) ? keys[index++] : key)),
    },
  };
}

export function setSidebarSectionHidden(
  layout: SidebarLayout | undefined,
  sectionId: string,
  hidden: boolean,
): SidebarLayout {
  const base = layout ?? emptySidebarLayout();
  return {
    ...base,
    hiddenSections: {
      ...(base.hiddenSections ?? {}),
      [sectionId]: hidden,
    },
  };
}

export function setSidebarItemHidden(
  layout: SidebarLayout | undefined,
  itemKey: string,
  hidden: boolean,
): SidebarLayout {
  const base = layout ?? emptySidebarLayout();
  return {
    ...base,
    hiddenItems: {
      ...(base.hiddenItems ?? {}),
      [itemKey]: hidden,
    },
  };
}

export function setSidebarRailSectionVisible(
  layout: SidebarLayout | undefined,
  sectionId: string,
  visible: boolean,
): SidebarLayout {
  const base = layout ?? emptySidebarLayout();
  return {
    ...base,
    railSections: {
      ...(base.railSections ?? {}),
      [sectionId]: visible,
    },
  };
}
