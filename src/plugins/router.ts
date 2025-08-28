import { App } from 'vue';
import router from '@/router';

export function setupRouter(app: App<Element>) {
  app.use(router);
}
