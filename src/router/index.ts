import { createRouter, createWebHistory } from 'vue-router';
import { useUserStore } from '@/store';

import Layout from '@/layout/Layout.vue';
import Login from '@/views/Login.vue';
import Home from '@/views/Home.vue';
import Discover from '@/views/Discover.vue';
import Search from '@/views/Search.vue';
import Profile from '@/views/Profile.vue';
import Setting from '@/views/Setting.vue';
import History from '@/views/History.vue';
import Cloud from '@/views/Cloud.vue';
import Playlist from '@/views/Playlist.vue';
import Album from '@/views/Album.vue';
import Singer from '@/views/Singer.vue';
import Error from '@/views/Error.vue';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      name: 'Layout',
      component: Layout,
      redirect: '/home',
      children: [
        { path: '/home', name: 'Home', component: Home },
        { path: '/discover', name: 'Discover', component: Discover },
        { path: '/search', name: 'SearchResult', component: Search },
        { path: '/login', name: 'Login', component: Login },
        { path: '/setting', name: 'Setting', component: Setting },
        { path: '/playlist', name: 'Playlist', component: Playlist },
        { path: '/album', name: 'Album', component: Album },
        { path: '/singer', name: 'Singer', component: Singer },
        { path: '/profile', name: 'Profile', component: Profile, meta: { auth: true } },
        { path: '/history', name: 'History', component: History, meta: { auth: true } },
        { path: '/cloud', name: 'Cloud', component: Cloud, meta: { auth: true } },
      ],
    },
    { path: '/:pathMatch(.*)*', component: Error },
  ],
});

// 全局前置守卫
router.beforeEach(async (to, from, next) => {
  console.log('from:', from.fullPath, 'to:', to.fullPath);

  const userStore = useUserStore();
  const isAuthenticated = userStore.isAuthenticated;

  // 显示加载动画
  if (window.$loadingBar) {
    window.$loadingBar.start();
  }

  try {
    if (to.name === 'Login') {
      if (isAuthenticated) {
        await userStore.initUserExtends();
        const targetPath = from.fullPath && from.fullPath !== to.fullPath ? from.fullPath : '/';
        next({ path: targetPath, replace: true });
      } else {
        next();
      }
      return;
    }

    if (to.meta.auth) {
      if (isAuthenticated) {
        await userStore.initUserExtends();
        next();
      } else {
        next({ path: '/login', replace: true });
      }
      return;
    }

    if (isAuthenticated) {
      await userStore.initUserExtends();
    }
    next();
  } finally {
    // 隐藏加载动画
    if (window.$loadingBar) {
      window.$loadingBar.finish();
    }
  }
});

export default router;
