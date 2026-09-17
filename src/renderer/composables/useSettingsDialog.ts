import { ref } from 'vue';

export const settingsDialogOpen = ref(false);
export const settingsDialogSection = ref('appearance');

export function openSettingsDialog(section = 'appearance') {
  settingsDialogSection.value = section;
  settingsDialogOpen.value = true;
}
