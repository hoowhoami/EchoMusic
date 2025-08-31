import { createApp } from 'vue';
import App from './App.vue';
import './styles/index.css';
import { setupPinia, setupNaive, setupRouter, setupDirectives } from './plugins';

const app = createApp(App);

setupPinia(app);

setupRouter(app);

setupNaive(app);

setupDirectives(app);

app.mount('#app');
