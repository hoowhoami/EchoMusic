<template>
  <div class="equalizer">
    <div class="bands">
      <div v-for="(gain, index) in gains" :key="index" class="band">
        <label>{{ frequencies[index] }}</label>
        <input
          type="range"
          min="-12"
          max="12"
          step="0.1"
          :value="gain"
          @input="updateGain(index, $event)"
        />
        <span>{{ gain.toFixed(1) }} dB</span>
      </div>
    </div>
    <button @click="resetGains">Reset</button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { usePlayerStore } from '@/stores/player';

const playerStore = usePlayerStore();

const gains = computed(() => playerStore.equalizerGains);

const frequencies = ['60', '170', '310', '600', '1k', '3k', '6k', '12k', '14k', '16k'];

const updateGain = (index: number, event: Event) => {
  const newGains = [...gains.value];
  newGains[index] = parseFloat((event.target as HTMLInputElement).value);
  playerStore.setEq(newGains);
};

const resetGains = () => {
  playerStore.setEq([0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
};
</script>

<style scoped>
.equalizer {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 1rem;
}
.bands {
  display: flex;
  gap: 1rem;
}
.band {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
}
</style>
