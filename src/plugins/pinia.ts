import { createPinia } from 'pinia';
import { createPersistedState } from 'pinia-plugin-persistedstate';
import { App } from 'vue';

export function setupPinia(app: App<Element>) {
  const pinia = createPinia();
  pinia.use(createPersistedState());
  app.use(pinia);
}
