import { createRouter, createWebHistory } from 'vue-router';
import { useUserStore } from '@/store';
import { dfid, userDetail, userVipDetail } from '@/api';

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
        { path: '/profile', name: 'Profile', component: Profile, meta: { auth: true } },
        { path: '/history', name: 'History', component: History, meta: { auth: true } },
        { path: '/cloud', name: 'Cloud', component: Cloud, meta: { auth: true } },
        { path: '/playlist', name: 'Playlist', component: Playlist, meta: { auth: true } },
        { path: '/album', name: 'Album', component: Album, meta: { auth: true } },
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
        await initUserExtends();
        const targetPath = from.fullPath && from.fullPath !== to.fullPath ? from.fullPath : '/';
        next({ path: targetPath, replace: true });
      } else {
        next();
      }
      return;
    }

    if (to.meta.auth) {
      if (isAuthenticated) {
        await initUserExtends();
        next();
      } else {
        next({ path: '/login', replace: true });
      }
      return;
    }

    if (isAuthenticated) {
      await initUserExtends();
    }
    next();
  } finally {
    // 隐藏加载动画
    if (window.$loadingBar) {
      window.$loadingBar.finish();
    }
  }
});

const initUserExtends = async () => {
  const userStore = useUserStore();
  if (userStore.hasExtends) {
    return;
  }
  const dfidResult = await dfid();
  userStore.setUserInfo({
    extends: {
      dfid: dfidResult.dfid,
    },
  });
  const detailResult = await userDetail();
  userStore.setUserInfo({
    extends: {
      detail: detailResult,
    },
  });
  const vipResult = await userVipDetail();
  userStore.setUserInfo({
    extends: {
      vip: vipResult,
    },
  });
};

export default router;
