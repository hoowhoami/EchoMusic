import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createPersistedState } from 'pinia-plugin-persistedstate';
import naive from 'naive-ui';
import App from './App.vue';
import router from './router';
import './styles/index.css';

const app = createApp(App);
const pinia = createPinia();
pinia.use(createPersistedState());

app.use(pinia);
app.use(router);
app.use(naive);
app.mount('#app');
