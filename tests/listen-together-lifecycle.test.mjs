import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { transformSync } from 'esbuild';
import * as vue from 'vue';
import * as pinia from 'pinia';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
function load(path, dependencies, globals = {}, names = []) {
  const module = { exports: {} };
  new Function(
    'require',
    'module',
    'exports',
    ...names,
    transformSync(read(path), { loader: 'ts', format: 'cjs' }).code,
  )(
    (name) => {
      assert.ok(name in dependencies, `unexpected dependency: ${name}`);
      return dependencies[name];
    },
    module,
    module.exports,
    ...names.map((name) => globals[name]),
  );
  return module.exports;
}
const object = load('../src/shared/object.ts', {});
const cover = load('../src/renderer/utils/cover.ts', {
  '@/plugins/coverFallback': {},
  './themedCover': {},
});
const shared = load('../src/renderer/utils/mappers/shared.ts', {
  '../cover': cover,
  '../../../shared/object': object,
});
const mapper = load('../src/renderer/utils/mappers/song.ts', { './shared': shared });
const utils = load('../src/renderer/utils/listenTogether.ts', {
  '@/utils/cover': cover,
  '@/utils/mappers/song': mapper,
});
const models = load('../src/renderer/models/listenTogether.ts', {});
const session = load('../src/renderer/utils/userSession.ts', {});
const songs = load('../src/renderer/utils/song.ts', {});
const tags = load('../src/renderer/utils/playlistTags.ts', {});
const vip = load('../src/renderer/utils/commentVip.ts', { '../../shared/object': object });
const playlists = load('../src/renderer/utils/mappers/playlist.ts', {
  './shared': shared,
  './song': mapper,
  '../song': songs,
  '../playlistTags': tags,
  '../commentVip': vip,
});
const orderHelper = load('../src/renderer/utils/playlistOrder.ts', {});
const trackSource = load('../src/renderer/utils/playlistTrackSource.ts', {});
const keyboard = load('../src/renderer/utils/composerKeyboard.ts', {});
const searchHelper = load('../src/renderer/views/search/searchHelpers.ts', {
  '@/utils/mappers': { ...mapper, ...playlists },
});
const { parse, compileScript } = createRequire(import.meta.url)('vue/compiler-sfc');
const { descriptor } = parse(read('../src/renderer/views/listenTogether/index.vue'));
const pageScript = transformSync(compileScript(descriptor, { id: 'listen-test' }).content, {
  loader: 'ts',
  format: 'cjs',
}).code;
const constants = {
  LISTEN_TOGETHER_QUEUE_ID: 'listen-together',
  PERSONAL_FM_QUEUE_ID: 'personal-fm',
};
const ok = (data = {}) => ({ status: 1, data });
const roomData = (id = 'one', owner = '7') => ({
  room_id: id,
  room_name: `room-${id}`,
  userid: owner,
  room_type: 0,
  allow_chat: 1,
});
const room = (id = 'one', owner = '7') => utils.mapListenTogetherRoom(roomData(id, owner), null, 0);
const rawSong = (id = 'song') => ({
  hash: id,
  album_audio_id: 9,
  songname: id,
  singername: 'artist',
  album_name: 'album',
  cover: 'https://cover/image',
  duration: 200,
});
const song = (id = 'song') => utils.mapListenTogetherSongList(ok({ list: [rawSong(id)] }))[0];
const orderData = () => ({
  song_info: rawSong(),
  user_info: { userid: 9, nick_name: 'requester' },
});
const order = () => utils.mapListenTogetherSongOrders(ok({ list: [orderData()] }))[0];
const flush = async () => {
  await vue.nextTick();
  await new Promise((resolve) => setImmediate(resolve));
};
const deferred = (t, fallback = ok()) => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  t.after(() => resolve(fallback));
  return { promise, resolve, reject };
};
const bounded = async (request) => {
  let timer;
  try {
    return await Promise.race([
      request,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('request did not settle within 500ms')), 500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};
const changeUser = (user, kind) => {
  if (kind === 'revision') user.accountRevision++;
  if (kind === 'token') user.info.token = 'two';
  if (kind === 'userid') user.info.userid = 8;
  if (kind === 'logout') user.isLoggedIn = false;
};
function fixture(t) {
  const activePinia = pinia.createPinia();
  pinia.setActivePinia(activePinia);
  const user = vue.reactive({
    isLoggedIn: true,
    accountRevision: 0,
    info: { userid: 7, token: 'one', nickname: 'user' },
  });
  const calls = {
    requests: [],
    notices: [],
    logs: [],
    queues: [],
    stops: 0,
    plays: [],
    seeks: [],
    toggles: 0,
  };
  const handlers = new Map(),
    timers = new Map(),
    events = new Map();
  let timerId = 0,
    play = async () => {},
    seek = async () => {};
  const defaults = (key, params) => {
    if (key.endsWith(':detail'))
      return ok(roomData(params.room_id, String(user.info?.userid ?? '')));
    if (key.endsWith(':state')) return ok({ room_state: 1 });
    if (
      key.endsWith(':history') ||
      key.endsWith(':members') ||
      key.endsWith(':list') ||
      key.endsWith(':playlist') ||
      key.endsWith(':recent_playlist') ||
      key.endsWith(':song_order_list')
    )
      return ok({ list: [], is_end: 1, total: 0 });
    if (key === 'room:create') return ok({ room_id: 'created' });
    return ok();
  };
  const api = load('../src/renderer/api/listenTogether.ts', {
    '@/models/listenTogether': models,
    '@/utils/request': {
      post: async (path, params, options) => {
        const key = `${path.split('/').at(-1)}:${options.params.operation}`;
        calls.requests.push({
          key,
          params: { ...params },
          userId: user.info?.userid,
          revision: user.accountRevision,
        });
        return handlers.has(key) ? handlers.get(key)(params) : defaults(key, params);
      },
    },
  });
  const fallback = { id: 'normal', songs: [] };
  const playlist = vue.reactive({
    activeQueueId: 'normal',
    lastNonFmQueueId: 'normal',
    activeQueue: fallback,
    playbackQueueList: [fallback],
    getQueueById: (id) => (id === 'normal' ? fallback : null),
    getPlaybackQueueSongs: () => [],
    setActiveQueue: (id) => {
      playlist.activeQueueId = id;
    },
    setPlaybackQueueWithOptions: (songs, _, options) => {
      calls.queues.push({ songs: songs.slice(), options });
      if (options.activate) playlist.activeQueueId = constants.LISTEN_TOGETHER_QUEUE_ID;
    },
    removePlaybackQueue: () => {},
    updateQueueCurrentTrack: () => {},
  });
  const player = vue.reactive({
    currentSourceQueueId: 'normal',
    currentPlaylist: [],
    currentTrackSnapshot: null,
    currentTrackId: '',
    currentAudioUrl: '',
    currentTime: 0,
    currentTimeUpdatedAt: Date.now(),
    isPlaying: false,
    isLoading: false,
    playbackDisplayState: 'ready',
    playMode: 'sequential',
    setAutoNextSuppressed: () => {},
    stop: () => {
      calls.stops++;
    },
    onPlayerEvent: (name, fn) => {
      if (!events.has(name)) events.set(name, new Set());
      events.get(name).add(fn);
      return () => events.get(name).delete(fn);
    },
    playTrack: async (...args) => {
      calls.plays.push(args);
      await play(...args);
    },
    seek: async (...args) => {
      calls.seeks.push(args);
      await seek(...args);
    },
    togglePlay: async () => {
      calls.toggles++;
      player.isPlaying = !player.isPlaying;
    },
  });
  const store = load(
    '../src/renderer/stores/listenTogether.ts',
    {
      vue,
      pinia,
      '@/api/listenTogether': api,
      '@/api/music': { getAudioMetadata: async () => ok() },
      '@/utils/listenTogether': utils,
      '@/utils/userSession': session,
      './player': { usePlayerStore: () => player },
      './lyric': { useLyricStore: () => ({ fetchLyrics: async () => {} }) },
      './playlist': { ...constants, usePlaylistStore: () => playlist },
      './user': { useUserStore: () => user },
      './toast': {
        useToastStore: () =>
          new Proxy(
            {},
            {
              get:
                (_, key) =>
                (...args) =>
                  calls.notices.push([key, ...args]),
            },
          ),
      },
      '@/utils/logger': Object.fromEntries(
        ['warn', 'info', 'debug', 'error'].map((key) => [
          key,
          (...args) => calls.logs.push([key, ...args]),
        ]),
      ),
    },
    {
      window: {
        setInterval: (fn, ms) => {
          const id = ++timerId;
          timers.set(id, { fn, ms });
          return id;
        },
        clearInterval: (id) => timers.delete(id),
      },
    },
    ['window'],
  ).useListenTogetherStore(activePinia);
  const dispose = () => {
    store.$dispose();
    activePinia._e.stop();
  };
  t.after(dispose);
  return {
    store,
    user,
    player,
    playlist,
    api,
    calls,
    timers,
    events,
    dispose,
    respond: (key, fn) => handlers.set(key, fn),
    default: (key) => handlers.delete(key),
    count: (key) => calls.requests.filter((request) => request.key === key).length,
    enter: async (id = 'one', owner = String(user.info?.userid ?? '')) => {
      await store.joinRoom(room(id, owner));
      await flush();
      calls.notices.length = 0;
    },
    tick: (ms) =>
      [...timers.values()].filter((timer) => timer.ms === ms).forEach((timer) => timer.fn()),
    emit: (name, payload = {}) => events.get(name)?.forEach((fn) => fn(payload)),
    play: (fn) => {
      play = fn;
    },
    seek: (fn) => {
      seek = fn;
    },
  };
}
for (const kind of ['revision', 'token', 'userid', 'logout']) {
  test(`round18: ${kind} resets active room, preview and private visible lists synchronously`, async (t) => {
    const f = fixture(t);
    await f.enter();
    f.store.previewRoom = room('preview');
    f.store.ownedRooms = [room()];
    changeUser(f.user, kind);
    assert.equal(f.store.joined, false);
    assert.equal(f.store.activeRoomId, '');
    assert.equal(f.store.previewRoom, null);
    assert.deepEqual(f.store.ownedRooms, []);
    assert.equal(f.timers.size, 0);
  });
}
for (const action of ['join', 'create', 'recover']) {
  for (const kind of ['revision', 'token', 'userid', 'reset']) {
    for (const outcome of ['success', 'error']) {
      test(`round18: ${action} preflight ${outcome} cannot continue after ${kind}`, async (t) => {
        const f = fixture(t),
          pending = deferred(t);
        f.respond('room:status', () => pending.promise);
        const request =
          action === 'join'
            ? f.store.joinRoom(room())
            : action === 'recover'
              ? f.store.recoverCurrentMusicRoomSession()
              : f.store.createRoom({
                  roomType: 0,
                  name: 'new',
                  notice: '',
                  audios: [{ hash: 'song', mixSongId: 9 }],
                  privacy: 1,
                });
        await flush();
        if (kind === 'reset') f.store.resetSessionState();
        else changeUser(f.user, kind);
        if (outcome === 'error') pending.reject(new Error('old request'));
        else pending.resolve(ok({ room_id: 'old', is_owner: 1 }));
        await request;
        await flush();
        assert.equal(f.count('room:join'), 0);
        assert.equal(f.count('room:create'), 0);
        assert.equal(f.count('music:detail'), 0);
        assert.equal(f.store.joined, false);
        assert.equal(f.timers.size, 0);
        assert.deepEqual(f.calls.notices, []);
      });
    }
  }
}
for (const stage of ['join', 'create', 'initialize']) {
  for (const outcome of ['success', 'error']) {
    test(`round18: late ${stage} ${outcome} after account change cannot hydrate or clean up using new account`, async (t) => {
      const f = fixture(t),
        pending = deferred(t);
      const key =
        stage === 'join' ? 'room:join' : stage === 'create' ? 'room:create' : 'music:initialize';
      f.respond(key, () => pending.promise);
      const request =
        stage === 'join'
          ? f.store.joinRoom(room())
          : f.store.createRoom({
              roomType: 0,
              name: 'new',
              notice: '',
              audios: [{ hash: 'song', mixSongId: 9 }],
              privacy: 1,
            });
      await flush();
      changeUser(f.user, 'token');
      if (outcome === 'error') pending.reject(new Error('old failure'));
      else pending.resolve(ok({ room_id: 'old' }));
      await request;
      await flush();
      assert.equal(f.store.activeRoomId, '');
      assert.equal(f.count('room:dismiss'), 0);
      assert.equal(f.count('music:playlist'), 0);
      if (stage === 'create') assert.equal(f.count('music:initialize'), 0);
      assert.deepEqual(f.calls.notices, []);
    });
  }
}
test('round18: duplicate joins share preflight and server join without a second request', async (t) => {
  const f = fixture(t),
    pending = deferred(t);
  f.respond('room:status', () => pending.promise);
  const one = f.store.joinRoom(room()),
    two = f.store.joinRoom(room());
  await flush();
  assert.equal(f.count('room:status'), 1);
  pending.resolve(ok());
  await one;
  await two;
  await flush();
  assert.equal(f.count('room:join'), 1);
});
test('round18: conflicting simultaneous transition is rejected without extra writes', async (t) => {
  const f = fixture(t),
    pending = deferred(t);
  f.respond('room:status', () => pending.promise);
  const one = f.store.joinRoom(room('one'));
  await flush();
  await assert.rejects(bounded(f.store.joinRoom(room('two'))), /切换房间/);
  assert.equal(f.count('room:status'), 1);
  pending.resolve(ok());
  await one;
});
for (const outcome of ['success', 'error']) {
  test(`round18: old leave ${outcome} cannot clear or toast in rejoined same room`, async (t) => {
    const f = fixture(t);
    await f.enter();
    const pending = deferred(t);
    f.respond('room:leave', () => pending.promise);
    const old = f.store.leaveRoom();
    f.store.resetSessionState();
    await f.enter();
    if (outcome === 'error') pending.reject(new Error('old leave'));
    else pending.resolve(ok());
    await old;
    assert.equal(f.store.joined, true);
    assert.equal(f.store.activeRoomId, 'one');
    assert.equal(f.timers.size, 3);
    assert.deepEqual(f.calls.notices, []);
  });
}
const roomOperations = [
  {
    name: 'messages',
    key: 'chat:history',
    run: (f) => f.store.loadMessages(),
    data: () =>
      ok({
        list: [
          { msgid: 'old', message: { msgtype: 801, alert: 'old', userid: 9 }, addtime: Date.now() },
        ],
      }),
  },
  {
    name: 'members',
    key: 'music:members',
    run: (f) => f.store.loadMembers(),
    data: () => ok({ list: [{ userid: 9, nick_name: 'old' }] }),
  },
  {
    name: 'orders',
    key: 'music:song_order_list',
    run: (f) => f.store.loadSongOrders(),
    data: () => ok({ list: [orderData()] }),
  },
  { name: 'send', key: 'chat:send', run: (f) => f.store.sendMessage('text'), data: () => ok() },
  {
    name: 'chat',
    key: 'room:update_chat',
    run: (f) => f.store.setChatEnabled(false),
    data: () => ok(),
  },
  {
    name: 'request',
    key: 'music:order_song',
    run: (f) => f.store.requestSong(song()),
    data: () => ok(),
  },
  {
    name: 'add',
    key: 'music:music_add',
    run: (f) => f.store.addRoomSong(song()),
    data: () => ok({ list_version: 'old' }),
  },
  {
    name: 'remove',
    key: 'music:remove_song',
    run: (f) => f.store.removeSongOrder(order()),
    data: () => ok(),
  },
  {
    name: 'sync',
    key: 'music:sync_player',
    run: (f) => f.store.syncPlayback(),
    data: () => ok({ hash: 'old', progress: 0, pause: 2 }),
  },
];
for (const operation of roomOperations) {
  for (const kind of ['rejoin', 'token']) {
    for (const outcome of ['success', 'error', 'dissolved']) {
      test(`round18: ${operation.name} ${outcome} cannot affect room after ${kind}`, async (t) => {
        const f = fixture(t);
        await f.enter();
        const pending = deferred(t);
        f.respond(operation.key, () => pending.promise);
        const old = operation.run(f);
        await flush();
        f.store.resetSessionState();
        if (kind === 'token') changeUser(f.user, 'token');
        f.default(operation.key);
        await f.enter();
        f.store.lastError = 'new-state';
        const calls = f.calls.requests.length;
        if (outcome === 'error') pending.reject(new Error('old error'));
        else
          pending.resolve(
            outcome === 'dissolved'
              ? { status: 0, error_code: 20005, error: '群组已解散' }
              : operation.data(),
          );
        await old;
        await flush();
        assert.equal(f.store.joined, true);
        assert.equal(f.store.lastError, 'new-state');
        assert.deepEqual(f.store.messages, []);
        assert.deepEqual(f.store.members, []);
        assert.deepEqual(f.store.songOrders, []);
        assert.equal(f.store.remotePlayback, null);
        assert.equal(f.store.activeRoom.allowChat, true);
        assert.equal(f.calls.requests.length, calls);
        assert.deepEqual(f.calls.notices, []);
      });
    }
  }
}
for (const operation of roomOperations.filter((operation) =>
  ['orders', 'send', 'chat', 'request', 'add', 'remove'].includes(operation.name),
)) {
  test(`round18: old ${operation.name} finally cannot release current busy operation`, async (t) => {
    const f = fixture(t);
    await f.enter();
    const oldPending = deferred(t),
      newPending = deferred(t);
    f.respond(operation.key, () => oldPending.promise);
    const old = operation.run(f);
    await flush();
    f.store.resetSessionState();
    f.default(operation.key);
    await f.enter();
    f.respond(operation.key, () => newPending.promise);
    const next = operation.run(f);
    await flush();
    oldPending.resolve(operation.data());
    await old;
    const busy =
      operation.name === 'orders'
        ? f.store.loadingSongOrders
        : operation.name === 'send'
          ? f.store.sendingMessage
          : operation.name === 'chat'
            ? f.store.updatingChat
            : operation.name === 'remove'
              ? f.store.handlingSongOrderId
              : f.store.requestingSongHash;
    assert.ok(busy);
    newPending.resolve(operation.data());
    await next;
  });
}
for (const kind of ['close', 'replace', 'token']) {
  for (const outcome of ['success', 'error', 'dissolved']) {
    test(`round18: preview ${kind} ignores old ${outcome}`, async (t) => {
      const f = fixture(t),
        pending = deferred(t, ok({ room_state: 1 }));
      f.respond('room:state', () => pending.promise);
      const old = f.store.inspectRoom(room('old'));
      await flush();
      if (kind === 'token') changeUser(f.user, 'token');
      else f.store.closePreview();
      if (kind === 'replace') {
        f.default('room:state');
        await f.store.inspectRoom(room('new'));
      }
      if (outcome === 'error') pending.reject(new Error('old preview'));
      else
        pending.resolve(
          outcome === 'dissolved' ? { status: 0, error_code: 20005 } : ok({ room_state: 1 }),
        );
      await old;
      assert.equal(f.store.previewRoom?.id ?? '', kind === 'replace' ? 'new' : '');
      assert.equal(f.store.lastError, '');
      assert.equal(f.store.loadingPreview, false);
      assert.deepEqual(f.store.dissolvedRoomKeys, []);
    });
  }
}
for (const stage of ['history', 'status', 'state', 'detail']) {
  test(`round18: private room ${stage} cannot continue or publish after token replacement`, async (t) => {
    const f = fixture(t),
      pending = deferred(t);
    const key =
      stage === 'history'
        ? 'music:history'
        : stage === 'status'
          ? 'room:status'
          : stage === 'state'
            ? 'room:state'
            : 'music:detail';
    f.respond('music:history', async () => ok({ list: [roomData('owned')] }));
    f.respond(key, () => pending.promise);
    const old = f.store.loadOwnedRooms(0);
    await flush();
    changeUser(f.user, 'token');
    const before = f.calls.requests.length;
    pending.resolve(
      stage === 'history'
        ? ok({ list: [roomData('owned')] })
        : stage === 'status'
          ? ok({ room_id: 'owned', is_owner: 1 })
          : stage === 'state'
            ? ok({ room_state: 1 })
            : ok(roomData('owned')),
    );
    await old;
    assert.equal(f.calls.requests.length, before);
    assert.deepEqual(f.store.ownedRooms, []);
    assert.deepEqual(f.store.ownedRoomIndex, []);
  });
}
test('round18: newest room list reset replaces pending list and old finally retains new busy', async (t) => {
  const f = fixture(t),
    first = deferred(t),
    second = deferred(t);
  f.respond('music:list', () => first.promise);
  const old = f.store.loadRooms({ reset: true, tagId: 'one' });
  f.respond('music:list', () => second.promise);
  const next = f.store.loadRooms({ reset: true, tagId: 'two' });
  first.resolve(ok({ list: [roomData('old')], total: 1, is_end: 1 }));
  await old;
  assert.equal(f.store.loadingRooms, true);
  assert.deepEqual(f.store.rooms, []);
  second.resolve(ok({ list: [roomData('new')], total: 1, is_end: 1 }));
  await next;
  assert.equal(f.store.rooms[0].id, 'new');
  assert.equal(f.store.activeTagId, 'two');
});
for (const kind of ['rejoin', 'token']) {
  test(`round18: queued owner command cannot publish after ${kind}; new command does not wait old flight`, async (t) => {
    const f = fixture(t);
    await f.enter();
    f.player.currentSourceQueueId = constants.LISTEN_TOGETHER_QUEUE_ID;
    const pending = deferred(t);
    f.respond('music:player_operation', () => pending.promise);
    f.emit('pause');
    await flush();
    f.emit('play');
    f.store.resetSessionState();
    if (kind === 'token') changeUser(f.user, 'token');
    await f.enter();
    f.player.currentSourceQueueId = constants.LISTEN_TOGETHER_QUEUE_ID;
    f.default('music:player_operation');
    f.emit('seek', { currentTime: 9 });
    await flush();
    assert.equal(f.count('music:player_operation'), 2);
    pending.resolve(ok({ list_version: 'old' }));
    await flush();
    assert.equal(f.count('music:player_operation'), 2);

    assert.equal(f.store.lastError, '');
  });
}
for (const interval of [5000, 15000, 55000]) {
  test(`round18: stale ${interval}ms callback cannot poll a new room`, async (t) => {
    const f = fixture(t);
    await f.enter();
    const old = [...f.timers.values()].find((timer) => timer.ms === interval).fn;
    f.store.resetSessionState();
    await f.enter();
    const count = f.calls.requests.length;
    old();
    await flush();
    assert.equal(f.calls.requests.length, count);
  });
  test(`round18: old ${interval}ms poll finally cannot unlock newer poll`, async (t) => {
    const f = fixture(t);
    await f.enter();
    const key =
      interval === 5000 ? 'chat:history' : interval === 15000 ? 'music:detail' : 'room:heartbeat';
    const oldPending = deferred(t),
      newPending = deferred(t);
    f.respond(key, () => oldPending.promise);
    f.tick(interval);
    await flush();
    f.store.resetSessionState();
    f.default(key);
    await f.enter();
    f.respond(key, () => newPending.promise);
    f.tick(interval);
    await flush();
    const count = f.count(key);
    oldPending.resolve(ok());
    await flush();
    f.tick(interval);
    await flush();
    assert.equal(f.count(key), count);
    newPending.resolve(ok());
    await flush();
  });
}
test('round18: old authorized URL rejection cannot start playback in rejoined room', async (t) => {
  const f = fixture(t);
  await f.enter();
  const track = song();
  track.listenTogetherCanPlay = 1;
  track.listenTogetherGenting = 2;
  f.store.roomSongs = [track];
  f.player.currentSourceQueueId = constants.LISTEN_TOGETHER_QUEUE_ID;
  const pending = deferred(t);
  f.respond('music:playback_url', () => pending.promise);
  f.respond('music:sync_player', async () => ok({ hash: track.hash, progress: 0, pause: 2 }));
  const old = f.store.syncPlayback(true);
  await flush();
  f.store.resetSessionState();
  f.default('music:sync_player');
  await f.enter();
  f.player.currentSourceQueueId = constants.LISTEN_TOGETHER_QUEUE_ID;
  pending.reject(new Error('old url'));
  await old;
  assert.deepEqual(f.calls.plays, []);
});
test('round18: failed seek clears 50ms observer and playback lock is retryable', async (t) => {
  const f = fixture(t);
  await f.enter();
  const track = song();
  f.store.roomSongs = [track];
  f.player.currentSourceQueueId = constants.LISTEN_TOGETHER_QUEUE_ID;
  f.player.currentTrackSnapshot = track;
  f.player.currentTrackId = track.id;
  f.player.currentAudioUrl = 'https://audio';
  f.respond('music:sync_player', async () => ok({ hash: track.hash, progress: 30, pause: 2 }));
  f.seek(async () => {
    throw new Error('seek failed');
  });
  await assert.rejects(f.store.syncPlayback(true), /seek failed/);
  assert.equal([...f.timers.values()].filter((timer) => timer.ms === 50).length, 0);
  f.seek(async () => {});
  f.respond('music:sync_player', async () => ok({ hash: track.hash, progress: 40, pause: 2 }));
  await f.store.syncPlayback(true);
  assert.equal(f.calls.seeks.length, 2);
});
test('round18: active seek superseded by session reset does not toggle or mutate new room', async (t) => {
  const f = fixture(t);
  await f.enter();
  const track = song();
  f.store.roomSongs = [track];
  f.player.currentSourceQueueId = constants.LISTEN_TOGETHER_QUEUE_ID;
  f.player.currentTrackSnapshot = track;
  f.player.currentTrackId = track.id;
  f.player.currentAudioUrl = 'https://audio';
  const pending = deferred(t);
  f.seek(() => pending.promise);
  f.respond('music:sync_player', async () => ok({ hash: track.hash, progress: 30, pause: 1 }));
  const old = f.store.syncPlayback(true);
  await flush();
  f.store.resetSessionState();
  f.default('music:sync_player');
  await f.enter();
  f.tick(50);
  await bounded(old);
  assert.equal(f.calls.toggles, 0);
  assert.equal([...f.timers.values()].filter((timer) => timer.ms === 50).length, 0);
  pending.resolve();
});
test('round18: store disposal stops timers and player subscriptions', async (t) => {
  const f = fixture(t);
  await f.enter();
  assert.equal(
    [...f.events.values()].reduce((sum, set) => sum + set.size, 0),
    5,
  );
  f.dispose();
  assert.equal(f.timers.size, 0);
  assert.equal(
    [...f.events.values()].reduce((sum, set) => sum + set.size, 0),
    0,
  );
});
test('round18: ordinary profile refresh preserves room and polling', async (t) => {
  const f = fixture(t);
  await f.enter();
  f.user.info.nickname = 'updated';
  await flush();
  assert.equal(f.store.joined, true);
  assert.equal(f.timers.size, 3);
});
test('round18: current join, create, recovery, chat and add protocols remain usable', async (t) => {
  const f = fixture(t);
  await f.enter();
  await f.store.sendMessage(' hi ');
  assert.equal(
    f.calls.requests.find((request) => request.key === 'chat:send').params.message,
    'hi',
  );
  await f.store.setChatEnabled(false);
  assert.equal(f.store.activeRoom.allowChat, false);
  assert.equal(await f.store.addRoomSong(song()), true);
  await f.store.leaveRoom({ silent: true });
  assert.equal(f.store.joined, false);
  const id = await f.store.createRoom(
    {
      roomType: 0,
      name: ' new ',
      notice: '',
      audios: [{ hash: 'song', mixSongId: 9 }],
      privacy: 1,
    },
    [song()],
  );
  assert.equal(id, 'created');
  assert.equal(f.store.joined, true);
  assert.equal(f.count('music:initialize'), 1);
  f.store.resetSessionState();
  f.respond('room:status', async () => ok({ room_id: 'restored', is_owner: 1 }));
  assert.equal(await f.store.recoverCurrentMusicRoomSession(), 'restored');
});

function pageFixture(t) {
  const f = fixture(t),
    hooks = { onMounted: [], onBeforeUnmount: [], onUnmounted: [] },
    timeouts = new Map();
  let timeoutId = 0,
    search = async () => ok({ lists: [] }),
    tracks = async () => ok({ list: [] });
  const pagePlaylist = Object.assign(f.playlist, {
    favorites: [],
    userPlaylists: [],
    likedPlaylist: null,
    getCreatedPlaylists: () => [],
    fetchUserPlaylists: async () => {},
    fetchLikedPlaylistSongs: async () => {},
    favoritesLoaded: true,
  });
  const dependencies = {
    vue: {
      ...vue,
      ...Object.fromEntries(
        Object.entries(hooks).map(([key, list]) => [key, (fn) => list.push(fn)]),
      ),
    },
    pinia,
    'vue-router': {
      useRoute: () => vue.reactive({ name: 'listen-together', query: {} }),
      useRouter: () => ({ push() {}, replace() {} }),
    },
    '@/utils/userSession': session,

    '@/utils/composerKeyboard': keyboard,
    '@/api/listenTogether': f.api,
    '@/api/playlist': {
      getPlaylistTracks: (...args) => tracks(...args),
      getPlaylistTracksNew: (...args) => tracks(...args),
    },
    '@/api/search': { search: (...args) => search(...args) },
    '@/utils/playlistTrackSource': trackSource,
    '@/utils/playlistOrder': orderHelper,
    '@/utils/listenTogether': utils,
    '@/utils/mappers': { ...mapper, ...playlists },
    '@/views/search/searchHelpers': searchHelper,
    '@/utils/share': { createShareTarget: () => ({}), copyShareTarget: async () => true },
    '@/icons': {},
    '@/stores/historyStore': {
      useHistoryStore: () => vue.reactive({ entries: [], hydrate: async () => {} }),
    },
    '@/stores/listenTogether': { useListenTogetherStore: () => f.store },
    '@/stores/player': { usePlayerStore: () => f.player },
    '@/stores/playlist': { usePlaylistStore: () => pagePlaylist },
    '@/stores/user': { useUserStore: () => f.user },
    '@/stores/toast': {
      useToastStore: () =>
        new Proxy(
          {},
          {
            get:
              (_, key) =>
              (...args) =>
                f.calls.notices.push([key, ...args]),
          },
        ),
    },
    '@/utils/logger': Object.fromEntries(
      ['warn', 'info', 'debug', 'error'].map((key) => [
        key,
        (...args) => f.calls.logs.push([key, ...args]),
      ]),
    ),
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'window', pageScript)(
    (name) => {
      if (name.endsWith('.vue') || name.endsWith('.css')) return {};
      assert.ok(name in dependencies, `unexpected dependency: ${name}`);
      return dependencies[name];
    },
    module,
    module.exports,
    {
      setTimeout: (fn) => {
        const id = ++timeoutId;
        timeouts.set(id, fn);
        return id;
      },
      clearTimeout: (id) => timeouts.delete(id),
    },
  );
  const scope = vue.effectScope();
  const view = scope.run(() => module.exports.default.setup({}, { expose() {} }));
  let disposed = false;
  const unmount = () => {
    if (disposed) return;
    disposed = true;
    hooks.onBeforeUnmount.forEach((fn) => fn());
    hooks.onUnmounted.forEach((fn) => fn());
    scope.stop();
  };
  t.after(unmount);
  return {
    ...f,
    view,
    timeouts,
    unmount,
    mount: () => hooks.onMounted.forEach((fn) => fn()),
    search: (fn) => {
      search = fn;
    },
    tracks: (fn) => {
      tracks = fn;
    },
  };
}
for (const kind of ['rejoin', 'token', 'unmount', 'draft']) {
  for (const outcome of ['success', 'error']) {
    test(`round18: chat UI preserves newer draft after ${kind} and old ${outcome}`, async (t) => {
      const f = pageFixture(t);
      await f.enter();
      const pending = deferred(t);
      f.respond('chat:send', () => pending.promise);
      f.view.messageText.value = 'old';
      const old = f.view.sendMessage();
      await flush();
      if (kind === 'token') changeUser(f.user, 'token');
      if (kind === 'rejoin') {
        f.store.resetSessionState();
        await f.enter();
      }
      if (kind === 'unmount') f.unmount();
      f.view.messageText.value = 'new';
      if (outcome === 'error') pending.reject(new Error('old send'));
      else pending.resolve(ok());
      await old;
      assert.equal(f.view.messageText.value, 'new');
      assert.equal(f.view.chatCooldown.value, false);
      if (kind !== 'draft' || outcome !== 'error') assert.deepEqual(f.calls.notices, []);
    });
  }
}
for (const kind of ['close', 'reopen', 'token', 'unmount', 'keyword']) {
  for (const outcome of ['success', 'error']) {
    test(`round18: picker ${kind} ignores old search ${outcome}`, async (t) => {
      const f = pageFixture(t);
      await f.enter();
      const pending = deferred(t);
      f.search(() => pending.promise);
      f.view.openOrderSongPicker();
      f.view.orderSongSearchKeyword.value = 'old';
      const old = f.view.searchOrderSongs();
      if (kind === 'close' || kind === 'reopen') f.view.orderSongPickerOpen.value = false;
      if (kind === 'reopen') f.view.openOrderSongPicker();
      if (kind === 'token') changeUser(f.user, 'token');
      if (kind === 'unmount') f.unmount();
      if (kind === 'keyword') f.view.orderSongSearchKeyword.value = 'new';
      if (outcome === 'error') pending.reject(new Error('old search'));
      else pending.resolve(ok({ lists: [rawSong('old')] }));
      await old;
      assert.deepEqual(f.view.orderSongSearchResults.value, []);
      assert.deepEqual(f.calls.notices, []);
    });
  }
}
for (const kind of ['close', 'token', 'unmount', 'source']) {
  test(`round18: picker ${kind} stops playlist cursor paging and stale publication`, async (t) => {
    const f = pageFixture(t);
    await f.enter();
    const pending = deferred(t);
    let reads = 0;
    f.tracks(() => {
      reads++;
      return pending.promise;
    });
    f.view.openOrderSongPicker();
    const old = f.view.loadOrderPlaylistSongs({ id: 3, listid: 3, listCreateUserid: 7 });
    if (kind === 'close') f.view.orderSongPickerOpen.value = false;
    if (kind === 'token') changeUser(f.user, 'token');
    if (kind === 'unmount') f.unmount();
    if (kind === 'source') await f.view.selectOrderSongSource('search');
    pending.resolve(
      ok({ list: Array.from({ length: 300 }, (_, index) => rawSong(`old-${index}`)) }),
    );
    await old;
    assert.equal(reads, 1);
    assert.deepEqual(f.view.orderPlaylistSongs.value, []);
  });
}
for (const kind of ['close', 'reopen', 'token', 'unmount']) {
  for (const outcome of ['success', 'error']) {
    test(`round18: create dialog ${kind} ignores late ${outcome}`, async (t) => {
      const f = pageFixture(t),
        pending = deferred(t, 'created');
      f.store.createRoom = () => pending.promise;
      f.player.currentPlaylist = [song()];
      f.view.createOpen.value = true;
      f.view.createName.value = 'old';
      const old = f.view.submitCreateRoom();
      if (kind === 'close' || kind === 'reopen') f.view.createOpen.value = false;
      if (kind === 'reopen') {
        f.view.createOpen.value = true;
        f.view.createName.value = 'new';
      }
      if (kind === 'token') changeUser(f.user, 'token');
      if (kind === 'unmount') f.unmount();
      const open = f.view.createOpen.value;
      if (outcome === 'error') pending.reject(new Error('old create'));
      else pending.resolve('created');
      await old;
      assert.equal(f.view.createOpen.value, open);
      assert.deepEqual(f.calls.notices, []);
    });
  }
}
for (const outcome of ['success', 'error']) {
  test(`round18: old preview ${outcome} does not close reopened preview`, async (t) => {
    const f = pageFixture(t),
      pending = deferred(t);
    f.store.inspectRoom = () => pending.promise;
    const old = f.view.openRoomPreview(room('old'));
    f.view.previewOpen.value = false;
    f.store.inspectRoom = async () => {};
    await f.view.openRoomPreview(room('new'));
    if (outcome === 'error') pending.reject(new Error('old preview'));
    else pending.resolve();
    await old;
    assert.equal(f.view.previewOpen.value, true);
    assert.deepEqual(f.calls.notices, []);
  });
  test(`round18: old dismiss ${outcome} cannot close or release reopened confirmation`, async (t) => {
    const f = pageFixture(t),
      first = deferred(t),
      second = deferred(t);
    f.store.dismissOwnedRoom = () => first.promise;
    f.view.openOwnedRoomDismiss(room('old'));
    const old = f.view.confirmDismissOwnedRoom();
    f.view.dismissOwnedOpen.value = false;
    f.view.openOwnedRoomDismiss(room('new'));
    f.store.dismissOwnedRoom = () => second.promise;
    const next = f.view.confirmDismissOwnedRoom();
    if (outcome === 'error') first.reject(new Error('old dismiss'));
    else first.resolve();
    await old;
    assert.equal(f.view.dismissOwnedOpen.value, true);
    assert.equal(f.view.dismissingOwnedRoom.value, true);
    assert.deepEqual(f.calls.notices, []);
    second.resolve();
    await next;
    assert.equal(f.view.dismissOwnedOpen.value, false);
  });
}
test('round18: page disposal preserves joined room polling but closes private preview', async (t) => {
  const f = pageFixture(t);
  await f.enter();
  f.store.previewRoom = room('preview');
  f.unmount();
  assert.equal(f.store.joined, true);
  assert.equal(f.timers.size, 3);
  assert.equal(f.store.previewRoom, null);
});
test('round18: current chat clears sent draft, preserves cooldown and picker search remains usable', async (t) => {
  const f = pageFixture(t);
  await f.enter();
  f.view.messageText.value = 'text';
  await f.view.sendMessage();
  assert.equal(f.view.messageText.value, '');
  assert.equal(f.view.chatCooldown.value, true);
  assert.equal(f.timeouts.size, 1);
  [...f.timeouts.values()][0]();
  assert.equal(f.view.chatCooldown.value, false);
  f.view.openOrderSongPicker();
  f.view.orderSongSearchKeyword.value = 'song';
  f.search(async () =>
    ok({ lists: [{ FileHash: 'song', MixSongID: 9, SongName: 'song', SingerName: 'artist' }] }),
  );
  await f.view.searchOrderSongs();
  assert.equal(f.view.orderSongSearchResults.value.length, 1);
  assert.equal(f.view.searchingOrderSongs.value, false);
});
test('round18: stale added list version is not included in next legitimate room add', async (t) => {
  const f = fixture(t);
  await f.enter();
  const pending = deferred(t);
  f.respond('music:music_add', () => pending.promise);
  const old = f.store.addRoomSong(song());
  f.store.resetSessionState();
  f.default('music:music_add');
  await f.enter();
  pending.resolve(ok({ list_version: 'old-version' }));
  await old;
  await f.store.addRoomSong(song());
  assert.equal(
    f.calls.requests.filter((request) => request.key === 'music:music_add').at(-1).params
      .list_version,
    '',
  );
});

test('round18: failed partial private history retains known rooms and remains refreshable', async (t) => {
  const f = fixture(t);
  f.store.ownedRoomIndex = [room('known')];
  f.store.ownedRooms = [room('known')];
  f.respond('music:history', async () => {
    throw new Error('history network');
  });
  await f.store.loadOwnedRooms(0);
  assert.deepEqual(
    f.store.ownedRoomIndex.map((entry) => entry.id),
    ['known'],
  );
  assert.deepEqual(
    f.store.ownedRooms.map((entry) => entry.id),
    ['known'],
  );
  f.respond('music:history', async () => ok({ list: [roomData('new')] }));
  await f.store.loadOwnedRooms(0);
  assert.deepEqual(
    f.store.ownedRooms.map((entry) => entry.id),
    ['new'],
  );
});
test('round18: failed public refresh preserves visible snapshot and first-page retry replaces it', async (t) => {
  const f = fixture(t);
  f.respond('music:list', async () => ok({ list: [roomData('old')], total: 1, is_end: 1 }));
  await f.store.loadRooms({ reset: true });
  f.respond('music:list', async () => {
    throw new Error('refresh');
  });
  await assert.rejects(f.store.loadRooms({ reset: true }));
  assert.deepEqual(
    f.store.rooms.map((entry) => entry.id),
    ['old'],
  );
  f.respond('music:list', async () => ok({ list: [roomData('new')], total: 1, is_end: 1 }));
  await f.store.loadRooms();
  assert.deepEqual(
    f.store.rooms.map((entry) => entry.id),
    ['new'],
  );
});
test('round18: repeated leave waits one server request and preserves offline leave feedback', async (t) => {
  const f = fixture(t);
  await f.enter();
  const pending = deferred(t);
  f.respond('room:leave', () => pending.promise);
  const first = f.store.leaveRoom(),
    second = f.store.leaveRoom();
  assert.equal(f.count('room:leave'), 1);
  pending.reject(new Error('leave unavailable'));
  await first;
  await second;
  assert.equal(f.store.joined, false);
  assert.equal(f.calls.notices.length, 1);
  assert.equal(f.calls.notices[0][0], 'warning');
});
test('round18: join from existing room shares in-flight leave and retains normal queue restoration', async (t) => {
  const f = fixture(t);
  await f.enter();
  const pending = deferred(t);
  f.respond('room:leave', () => pending.promise);
  const first = f.store.joinRoom(room('two'));
  await flush();
  const second = f.store.joinRoom(room('two'));
  assert.equal(f.count('room:leave'), 1);
  pending.resolve(ok());
  await first;
  await second;
  await flush();
  assert.equal(f.store.activeRoomId, 'two');
  assert.equal(f.timers.size, 3);
  await f.store.leaveRoom({ silent: true });
  assert.equal(f.playlist.activeQueueId, 'normal');
});
test('round18: room owner playlist cursor stops when first page becomes stale', async (t) => {
  const f = fixture(t);
  await f.enter();
  const pending = deferred(t);
  f.respond('music:playlist', () => pending.promise);
  const old = f.store.loadRoomSongs(true);
  f.store.resetSessionState();
  const before = f.count('music:playlist');
  pending.resolve(
    ok({ list: Array.from({ length: 50 }, (_, index) => rawSong(`old-${index}`)), quantity: 100 }),
  );
  await old;
  assert.equal(f.count('music:playlist'), before);
  assert.deepEqual(f.store.roomSongs, []);
});
test('round18: late old room sync cannot override a newer snapshot within same session', async (t) => {
  const f = fixture(t);
  await f.enter();
  const pending = deferred(t);
  f.respond('music:sync_player', () => pending.promise);
  const old = f.store.syncPlayback();
  f.respond('music:sync_player', async () => ok({ hash: 'new', progress: 0, pause: 2 }));
  await f.store.syncPlayback();
  pending.resolve(ok({ hash: 'old', progress: 0, pause: 2 }));
  await old;
  assert.equal(f.store.remotePlayback.hash, 'new');
});
test('round18: current dissolved-room response still ends local session and warns once', async (t) => {
  const f = fixture(t);
  await f.enter();
  f.respond('chat:history', async () => ({ status: 0, error_code: 20005 }));
  await f.store.loadMessages();
  assert.equal(f.store.joined, false);
  assert.equal(f.timers.size, 0);
  assert.equal(f.calls.notices.length, 1);
  assert.match(f.store.lastError, /已解散/);
});
test('round18: closing picker resets search busy and old finally cannot release new search', async (t) => {
  const f = pageFixture(t);
  await f.enter();
  const first = deferred(t),
    second = deferred(t);
  f.view.openOrderSongPicker();
  f.view.orderSongSearchKeyword.value = 'old';
  f.search(() => first.promise);
  const old = f.view.searchOrderSongs();
  f.view.orderSongPickerOpen.value = false;
  f.view.openOrderSongPicker();
  f.view.orderSongSearchKeyword.value = 'new';
  f.search(() => second.promise);
  const next = f.view.searchOrderSongs();
  first.resolve(ok({ lists: [] }));
  await old;
  assert.equal(f.view.searchingOrderSongs.value, true);
  second.resolve(ok({ lists: [] }));
  await next;
  assert.equal(f.view.searchingOrderSongs.value, false);
});
test('round18: changing picker source releases obsolete search busy and retains new request', async (t) => {
  const f = pageFixture(t);
  await f.enter();
  const pending = deferred(t);
  f.search(() => pending.promise);
  f.view.openOrderSongPicker();
  f.view.orderSongSearchKeyword.value = 'same';
  const old = f.view.searchOrderSongs();
  await f.view.selectOrderSongSource('recent');
  await f.view.selectOrderSongSource('search');
  assert.equal(f.view.searchingOrderSongs.value, false);
  f.search(async () => ok({ lists: [{ FileHash: 'new', MixSongID: 9 }] }));
  await f.view.searchOrderSongs();
  pending.resolve(ok({ lists: [{ FileHash: 'old', MixSongID: 9 }] }));
  await old;
  assert.equal(f.view.orderSongSearchResults.value[0].hash, 'new');
});
test('round18: old leave UI completion cannot close a new confirmation after room rejoin', async (t) => {
  const f = pageFixture(t);
  await f.enter('one', 'other');
  const pending = deferred(t);
  f.respond('room:leave', () => pending.promise);
  f.view.leaveOpen.value = true;
  const old = f.view.confirmLeave();
  f.store.resetSessionState();
  f.default('room:leave');
  await f.enter('one', 'other');
  f.view.leaveOpen.value = true;
  pending.resolve(ok());
  await old;
  assert.equal(f.view.leaveOpen.value, true);
});
