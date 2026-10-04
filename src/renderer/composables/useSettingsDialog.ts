import { ref } from 'vue';

export const settingsDialogOpen = ref(false);
export const settingsDialogSection = ref('interface');

export function openSettingsDialog(section = 'interface') {
  settingsDialogSection.value = section;
  settingsDialogOpen.value = true;
}
