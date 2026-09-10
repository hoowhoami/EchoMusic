import { watch, onBeforeUnmount, type Ref } from 'vue';
import Sortable from 'sortablejs';

/** Restore Sortable's DOM mutation before Vue applies the saved order. */
export function useTitlebarSort(
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
        draggable: '[data-titlebar-key]',
        dataIdAttr: 'data-titlebar-key',
        handle,
        animation: 150,
        forceFallback: true,
        fallbackTolerance: 5,
        ghostClass: 'titlebar-sort-ghost',
        chosenClass: 'titlebar-sort-chosen',
        onStart: () => {
          started = keys();
        },
        onEnd: () => {
          const reordered = sortable?.toArray() ?? [];
          const current = keys();
          sortable?.sort(current, false);
          // A plugin may unload or update visibility while dragging: discard that drop.
          if (JSON.stringify(started) !== JSON.stringify(current)) return;
          if (
            reordered.length === current.length &&
            new Set(reordered).size === current.length &&
            reordered.every((key) => current.includes(key))
          )
            save(reordered);
        },
      });
    },
    { flush: 'post' },
  );
  onBeforeUnmount(() => sortable?.destroy());
}
