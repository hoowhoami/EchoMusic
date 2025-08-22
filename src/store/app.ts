import { defineStore } from 'pinia';
import { ref } from 'vue';

export const useAppStore = defineStore(
  'app',
  () => {
    const theme = ref<'light' | 'dark'>('light');
    const volume = ref<number>(80);
    const isPlaying = ref<boolean>(false);
    const currentTrack = ref<string | null>(null);
    const playlist = ref<string[]>([]);

    const toggleTheme = () => {
      theme.value = theme.value === 'light' ? 'dark' : 'light';
    };

    const setVolume = (newVolume: number) => {
      volume.value = Math.max(0, Math.min(100, newVolume));
    };

    const togglePlay = () => {
      isPlaying.value = !isPlaying.value;
    };

    const setCurrentTrack = (track: string) => {
      currentTrack.value = track;
    };

    const addToPlaylist = (track: string) => {
      if (!playlist.value.includes(track)) {
        playlist.value.push(track);
      }
    };

    const removeFromPlaylist = (track: string) => {
      const index = playlist.value.indexOf(track);
      if (index > -1) {
        playlist.value.splice(index, 1);
      }
    };

    return {
      theme,
      volume,
      isPlaying,
      currentTrack,
      playlist,
      toggleTheme,
      setVolume,
      togglePlay,
      setCurrentTrack,
      addToPlaylist,
      removeFromPlaylist,
    };
  },
  {
    persist: true,
  },
);
