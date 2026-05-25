import { ref } from 'vue';

const isOpen = ref(false);
const activeSection = ref('appearance');

export function useSettingsDialog() {
  const open = (section?: string) => {
    if (section) activeSection.value = section;
    isOpen.value = true;
  };

  const close = () => {
    isOpen.value = false;
  };

  return {
    isOpen,
    activeSection,
    open,
    close,
  };
}
