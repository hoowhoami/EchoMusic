import { computed, onActivated, onBeforeUnmount, onDeactivated, ref, type Ref } from 'vue';

/** Hide portalled overlays while their owner is cached, even if a parent ignores close requests. */
export function useCachedOverlayOpen(model: Ref<boolean>) {
  const suspended = ref(false);
  const disposed = ref(false);
  const available = computed(() => !suspended.value && !disposed.value);
  const open = computed({
    get: () => available.value && model.value,
    set: (value: boolean) => {
      if (disposed.value || (value && !available.value)) return;
      model.value = value;
    },
  });

  onDeactivated(() => {
    suspended.value = true;
    if (model.value) model.value = false;
  });
  onActivated(() => {
    if (!disposed.value) suspended.value = false;
  });
  onBeforeUnmount(() => {
    disposed.value = true;
  });

  return open;
}
