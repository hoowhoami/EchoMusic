import { onBeforeUnmount, watch, type Ref } from 'vue';
import Sortable from 'sortablejs';

export function usePlayerBarSort(
  target: Ref<HTMLElement | null>,
  keys: () => string[],
  save: (keys: string[]) => void,
  handle: string,
) {
  let sortable: Sortable | undefined;
  let started: string[] = [];
  watch(
    target,
    (element) => {
      sortable?.destroy();
      sortable = undefined;
      if (!element) return;
      sortable = new Sortable(element, {
        draggable: '[data-playerbar-key]',
        dataIdAttr: 'data-playerbar-key',
        handle,
        animation: 150,
        forceFallback: true,
        fallbackTolerance: 5,
        ghostClass: 'playerbar-sort-ghost',
        chosenClass: 'playerbar-sort-chosen',
        onStart: () => {
          started = keys();
        },
        onEnd: () => {
          const reordered = sortable?.toArray() ?? [];
          const current = keys();
          sortable?.sort(current, false);
          if (JSON.stringify(started) !== JSON.stringify(current)) return;
          if (
            reordered.length === current.length &&
            new Set(reordered).size === current.length &&
            reordered.every((key) => current.includes(key))
          ) {
            save(reordered);
          }
        },
      });
    },
    { flush: 'post' },
  );
  onBeforeUnmount(() => sortable?.destroy());
}
