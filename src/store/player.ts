import { defineStore } from 'pinia';

interface Player {
  isPlaying: boolean;
}

export const usePlayerStore = defineStore('player', {
  persist: true,
  state: (): Player => ({
    isPlaying: false,
  }),
  getters: {},
  actions: {},
});
