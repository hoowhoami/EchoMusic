import { createApp } from 'vue';
import { Icon } from '@iconify/vue';
import App from './App.vue';
import '../renderer/style.css';

const app = createApp(App);

app.component('Icon', Icon);
app.mount('#app');
