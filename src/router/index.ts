import { createRouter, createWebHistory } from 'vue-router';
import Layout from '@/layout/Layout.vue';
import Home from '@/views/Home.vue';
import Discover from '@/views/Discover.vue';
import Search from '@/views/Search.vue';
import User from '@/views/User.vue';
import History from '@/views/History.vue';
import Cloud from '@/views/Cloud.vue';
import Playlist from '@/views/Playlist.vue';
import Album from '@/views/Album.vue';

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
  const isLogin = !!localStorage.getItem('token');

  // 未登录且需要登录的路由 → 跳转到登录页
  if (to.meta.auth !== false && !isLogin) {
    next(`/login?redirect=${to.fullPath}`);
  } else {
    next();
  }
});

export default router;
