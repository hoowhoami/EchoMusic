import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { Icon } from '@iconify/vue';
import App from './App.vue';
import { installPluginRuntime } from '@/plugins/runtime';
import { installInputBehaviorGuard } from '@/utils/inputBehaviorGuard';
import { useSettingStore } from '@/stores/setting';
import { sqlitePersistPlugin } from '@/stores/sqlitePersist';
import '../renderer/style.css';

const app = createApp(App);
const pinia = createPinia();
const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    {
      path: '/',
      name: 'desktop-lyric',
      component: App,
    },
  ],
});

pinia.use(sqlitePersistPlugin);
app.use(pinia);
app.use(router);
app.component('Icon', Icon);
installInputBehaviorGuard({
  isEnabled: () => useSettingStore().suppressDefaultKeyBehaviors,
});
installPluginRuntime({ app, router, pinia });
app.mount('#app');
