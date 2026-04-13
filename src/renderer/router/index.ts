import {
  createRouter,
  createWebHashHistory,
  type RouteLocationNormalized,
  type RouteRecordRaw,
} from 'vue-router';

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    name: 'loading',
    component: () => import('@/views/Loading.vue'),
    meta: { skipHistory: true },
  },
  {
    path: '/login',
    name: 'login',
    component: () => import('@/views/Login.vue'),
    meta: { skipHistory: true },
  },
  {
    path: '/lyric',
    name: 'lyric',
    component: () => import('@/views/Lyric.vue'),
    meta: { skipHistory: true },
  },
  {
    path: '/main',
    component: () => import('@/layouts/MainLayout.vue'),
    children: [
      {
        path: 'home',
        name: 'home',
        component: () => import('@/views/Home.vue'),
      },
      {
        path: 'personal-fm',
        name: 'personal-fm',
        component: () => import('@/views/PersonalFm.vue'),
        meta: { title: '私人 FM', keepAlive: true },
      },
      {
        path: 'recommend',
        name: 'recommend-songs',
        component: () => import('@/views/RecommendSongs.vue'),
        meta: { title: '每日推荐' },
      },
      {
        path: 'explore',
        name: 'explore',
        component: () => import('@/views/Explore.vue'),
      },
      {
        path: 'search',
        name: 'search',
        component: () => import('@/views/Search.vue'),
        meta: { title: '搜索' },
      },
      {
        path: 'ranking',
        name: 'ranking',
        component: () => import('@/views/Ranking.vue'),
      },
      {
        path: 'history',
        name: 'history',
        component: () => import('@/views/History.vue'),
      },
      {
        path: 'liked',
        name: 'liked-songs',
        component: () => import('@/views/LikedSongs.vue'),
      },
      {
        path: 'cloud',
        name: 'cloud',
        component: () => import('@/views/Cloud.vue'),
      },
      {
        path: 'profile',
        name: 'profile',
        component: () => import('@/views/Profile.vue'),
      },
      {
        path: 'settings',
        name: 'settings',
        component: () => import('@/views/Settings.vue'),
      },
      {
        path: 'playlist/:id',
        name: 'playlist-detail',
        component: () => import('@/views/details/PlaylistDetail.vue'),
        meta: { title: '歌单详情' },
      },
      {
        path: 'artist/:id',
        name: 'artist-detail',
        component: () => import('@/views/details/ArtistDetail.vue'),
        meta: { title: '歌手详情' },
      },
      {
        path: 'album/:id',
        name: 'album-detail',
        component: () => import('@/views/details/AlbumDetail.vue'),
        meta: { title: '专辑详情' },
      },
      {
        path: 'comment/:id',
        name: 'comment',
        component: () => import('@/views/details/CommentPage.vue'),
        meta: { title: '评论' },
      },
      {
        path: 'mv/:id',
        name: 'mv-detail',
        component: () => import('@/views/details/MvDetail.vue'),
        meta: { title: 'MV详情' },
      },
      {
        path: 'error',
        name: 'error',
        component: () => import('@/views/ErrorPage.vue'),
        meta: { title: '出错了' },
      },
    ],
  },
];

const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

const shouldSkipHistory = (route: RouteLocationNormalized): boolean => {
  return route.matched.some((record) => record.meta?.skipHistory === true);
};

router.beforeEach((to, from) => {
  const skipToHistory = shouldSkipHistory(to);
  const skipFromHistory = from.matched.length > 0 && shouldSkipHistory(from);

  if ((!skipToHistory && !skipFromHistory) || to.redirectedFrom) return true;

  return {
    ...to,
    replace: true,
  };
});

export default router;
