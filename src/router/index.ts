import { createRouter, createWebHistory } from 'vue-router';
import { useUserStore } from '@/store';

import Layout from '@/layout/Layout.vue';
import Login from '@/views/Login.vue';
import Home from '@/views/Home.vue';
import Discover from '@/views/Discover.vue';
import Search from '@/views/Search.vue';
import User from '@/views/User.vue';
import History from '@/views/History.vue';
import Cloud from '@/views/Cloud.vue';
import Playlist from '@/views/Playlist.vue';
import Album from '@/views/Album.vue';
import Error from '@/views/Error.vue';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'Layout',
      component: Layout,
      children: [
        { path: '', name: 'Home', component: Home },
        { path: '/discover', name: 'Discover', component: Discover },
        { path: '/search', name: 'SearchResult', component: Search },
        { path: '/login', name: 'Login', component: Login },
        { path: '/user', name: 'User', component: User, meta: { auth: true } },
        { path: '/history', name: 'History', component: History, meta: { auth: true } },
        { path: '/cloud', name: 'Cloud', component: Cloud, meta: { auth: true } },
        {
          path: '/playlist/:type',
          name: 'Playlist',
          component: Playlist,
          meta: { auth: true },
        },
        {
          path: '/album',
          name: 'Album',
          component: Album,
          meta: { auth: true },
        },
      ],
    },
    { path: '/:pathMatch(.*)*', component: Error },
  ],
});

// 全局前置守卫：验证登录状态
router.beforeEach((to, from, next) => {
  console.log('from:', from.fullPath, 'to:', to.fullPath);

  const userStore = useUserStore();
  const isAuthenticated = userStore.isAuthenticated;

  // 1. 如果要去登录页
  if (to.name === 'Login') {
    if (isAuthenticated) {
      // 已登录状态访问登录页：跳转到上一个页面（如果有有效来源），否则跳首页
      // 这里用 replace 确保跳转后不会回退到登录页
      const targetPath = from.fullPath && from.fullPath !== to.fullPath ? from.fullPath : '/';
      next({ path: targetPath, replace: true });
    } else {
      // 未登录访问登录页：正常进入
      next();
    }
    return; // 终止后续逻辑
  }

  // 2. 非登录页的路由（验证权限）
  if (to.meta.auth) {
    if (isAuthenticated) {
      // 已登录：正常进入
      next();
    } else {
      // 未登录：跳转到登录页（用 replace 模式，避免登录页被存入历史记录）
      // 这样登录后点击后退不会回到登录页
      next({ path: '/login', replace: true });
    }
    return; // 终止后续逻辑
  }

  // 3. 其他无需验证的路由：直接放行
  next();
});

export default router;
