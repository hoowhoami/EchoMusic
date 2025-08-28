import { createApp } from 'vue';
import App from './App.vue';
import './styles/index.css';
import { setupPinia, setupNaive, setupRouter } from './plugins';

const app = createApp(App);

setupPinia(app);

setupRouter(app);

setupNaive(app);

app.mount('#app');
