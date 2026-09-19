import { createApp } from 'vue';
import TaskbarPlayerView from './TaskbarPlayerView.vue';

// Deliberately isolated: no router, player stores, login flow or second audio engine.
createApp(TaskbarPlayerView).mount('#app');
