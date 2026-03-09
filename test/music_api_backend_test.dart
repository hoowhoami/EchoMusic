import 'package:echomusic/api/backend/music_api_backend.dart';
import 'package:echomusic/api/backend/library/common.dart';
import 'package:echomusic/api/backend/library/core.dart';
import 'package:echomusic/api/backend/library/kugou_bridge.dart';
import 'package:echomusic/api/backend/library_music_api_backend.dart';
import 'package:echomusic/api/music_api.dart';
import 'package:echomusic/models/song.dart';
import 'package:echomusic/providers/persistence_provider.dart';
import 'package:echomusic/utils/logger.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _FakeMusicApiBackend extends MusicApiBackend {
  Map<String, dynamic>? registerDeviceResult;
  Map<String, dynamic>? songUrlResult;
  List<Song> newSongsResult = const [];
  Map<String, dynamic> playlistTrackAllResult = const {};

  bool registerDeviceCalled = false;
  String? lastSongUrlHash;
  String? lastSongUrlQuality;
  String? lastPlaylistTrackAllId;
  final List<String?> syncedAuthCookies = [];

  @override
  Future<Map<String, dynamic>?> registerDevice() async {
    registerDeviceCalled = true;
    return registerDeviceResult;
  }

  @override
  Future<Map<String, dynamic>?> getSongUrl(
    String hash, {
    String quality = '',
  }) async {
    lastSongUrlHash = hash;
    lastSongUrlQuality = quality;
    return songUrlResult;
  }

  @override
  Future<List<Song>> getNewSongs() async => newSongsResult;

  @override
  Future<Map<String, dynamic>> getPlaylistTrackAll(
    String id, {
    int page = 1,
    int pagesize = 30,
  }) async {
    lastPlaylistTrackAllId = id;
    return playlistTrackAllResult;
  }

  @override
  Future<void> syncAuthCookie(String? cookie) async {
    syncedAuthCookies.add(cookie);
  }

  @override
  Future<void> dispose() async {}
}

class _FakeKugouMusicApiBridge implements LibraryMusicBridge {
  final List<Map<String, dynamic>> requests = [];
  Map<String, String> cookie = {};
  final Map<String, LibraryMusicResponse> responses = {};

  @override
  Map<String, String> get debugCookie => Map<String, String>.from(cookie);

  @override
  Future<void> setCookie(Map<String, String> cookie) async {
    this.cookie = Map<String, String>.from(cookie);
  }

  @override
  Future<LibraryMusicResponse> request(
    String route, {
    Map<String, String>? cookie,
    KugouProcessEnv? env,
    Map<String, dynamic>? query,
  }) async {
    requests.add({'route': route, 'cookie': cookie, 'query': query});
    return responses[route] ??
        LibraryMusicResponse(headers: const {}, body: const {}, status: 500);
  }

  @override
  Future<void> dispose() async {}
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    await LoggerService.init();
    await MusicApi.resetTransport();
  });

  tearDown(() async {
    await MusicApi.resetTransport();
  });

  test('MusicApi delegates simple methods to injected backend', () async {
    final backend = _FakeMusicApiBackend()
      ..registerDeviceResult = {'dfid': 'backend-device'}
      ..songUrlResult = {'url': 'https://example.com/backend.mp3', 'status': 1}
      ..newSongsResult = [
        Song(
          hash: 'backend-hash',
          name: 'Backend Song',
          albumName: 'Backend Album',
          singers: [SingerInfo(id: 1, name: 'Backend Singer')],
          duration: 180,
          cover: 'https://example.com/backend.jpg',
          mixSongId: 42,
        ),
      ];
    await MusicApi.setBackend(backend);

    final device = await MusicApi.registerDevice();
    final songUrl = await MusicApi.getSongUrl('hash-1', quality: '320');
    final newSongs = await MusicApi.getNewSongs();

    expect(backend.registerDeviceCalled, isTrue);
    expect(device?['dfid'], 'backend-device');
    expect(backend.lastSongUrlHash, 'hash-1');
    expect(backend.lastSongUrlQuality, '320');
    expect(songUrl?['url'], 'https://example.com/backend.mp3');
    expect(newSongs, hasLength(1));
    expect(newSongs.single.name, 'Backend Song');
  });

  test('MusicApi keeps playlist helper composition above backend', () async {
    final backend = _FakeMusicApiBackend()
      ..playlistTrackAllResult = {
        'data': {
          'songs': [
            {
              'hash': 'playlist-hash',
              'songname': 'Playlist Song',
              'author_name': 'Playlist Singer',
              'timelen': 180000,
              'mixsongid': 77,
            },
          ],
        },
      };
    await MusicApi.setBackend(backend);

    final songs = await MusicApi.getPlaylistSongs('playlist-id');

    expect(backend.lastPlaylistTrackAllId, 'playlist-id');
    expect(songs, hasLength(1));
    expect(songs.single.name, 'Playlist Song');
    expect(songs.single.mixSongId, 77);
  });

  test('MusicApi syncs stored auth cookie into injected backend', () async {
    SharedPreferences.setMockInitialValues({
      'device_info':
          '{"dfid":"dfid-1","mid":"mid-1","guid":"guid-1","serverDev":"dev-1","mac":"mac-1"}',
      'user_info': '{"token":"token-1","userid":123,"t1":"t1-1"}',
    });

    final backend = _FakeMusicApiBackend();
    await MusicApi.setBackend(backend);

    expect(backend.syncedAuthCookies, [
      'token=token-1;userid=123;dfid=dfid-1;t1=t1-1;KUGOU_API_MID=mid-1;KUGOU_API_GUID=guid-1;KUGOU_API_DEV=dev-1;KUGOU_API_MAC=mac-1',
    ]);
  });

  test(
    'PersistenceProvider syncs backend auth when stored login changes',
    () async {
      final backend = _FakeMusicApiBackend();
      await MusicApi.setBackend(backend);
      backend.syncedAuthCookies.clear();

      final provider = PersistenceProvider();

      await provider.setDevice({'dfid': 'dfid-2', 'mid': 'mid-2'});
      expect(backend.syncedAuthCookies.last, 'dfid=dfid-2;KUGOU_API_MID=mid-2');

      await provider.setUserInfo({'token': 'token-2', 'userid': 456});
      expect(
        backend.syncedAuthCookies.last,
        'token=token-2;userid=456;dfid=dfid-2;KUGOU_API_MID=mid-2',
      );
    },
  );

  test('LibraryMusicApiBackend parses cookie string into cookie map', () async {
    final bridge = _FakeKugouMusicApiBridge();
    final backend = LibraryMusicApiBackend(
      bridge: bridge,
      readyEnsurer: () async {},
    );

    await backend.syncAuthCookie(
      'token=token-1;userid=123;dfid=dfid-1;KUGOU_API_GUID=guid-1',
    );

    expect(bridge.cookie, {
      'token': 'token-1',
      'userid': '123',
      'dfid': 'dfid-1',
      'KUGOU_API_GUID': 'guid-1',
    });
  });

  test('LibraryMusicApiBackend keeps HTTP-style route names', () async {
    final bridge = _FakeKugouMusicApiBridge();
    final backend = LibraryMusicApiBackend(
      bridge: bridge,
      readyEnsurer: () async {},
    );
    bridge.responses['/top/song'] = LibraryMusicResponse(
      headers: const {},
      body: const {'data': []},
      status: 200,
    );

    await backend.getNewSongs();

    expect(bridge.requests.single['route'], '/top/song');
  });

  test(
    'LibraryMusicApiBackend registerDevice aligns with HTTP semantics and skips auth cookie',
    () async {
      final bridge = _FakeKugouMusicApiBridge();
      final backend = LibraryMusicApiBackend(
        bridge: bridge,
        readyEnsurer: () async {},
      );
      await backend.syncAuthCookie('token=token-1;userid=123');
      bridge.responses['/register/dev'] = LibraryMusicResponse(
        headers: const {},
        body: const {
          'status': 1,
          'data': {'dfid': 'device-1'},
        },
        status: 200,
      );

      final result = await backend.registerDevice();

      expect(bridge.requests.single['route'], '/register/dev');
      expect(bridge.requests.single['cookie'], <String, String>{});
      expect(result, {'dfid': 'device-1'});
    },
  );

  test(
    'LibraryMusicApiBackend getSongUrl aligns with HTTP semantics',
    () async {
      final bridge = _FakeKugouMusicApiBridge();
      final backend = LibraryMusicApiBackend(
        bridge: bridge,
        readyEnsurer: () async {},
      );
      bridge.responses['/song/url'] = LibraryMusicResponse(
        headers: const {},
        body: const {
          'status': 1,
          'data': {
            'url': ['https://example.com/library.mp3'],
          },
        },
        status: 200,
      );

      final result = await backend.getSongUrl('hash-1', quality: '320');

      expect(bridge.requests.single['route'], '/song/url');
      expect(bridge.requests.single['query'], {
        'hash': 'hash-1',
        'quality': '320',
      });
      expect(result, {'url': 'https://example.com/library.mp3', 'status': 1});
    },
  );

  test('LibraryMusicApiBackend getNewSongs parses top song payload', () async {
    final bridge = _FakeKugouMusicApiBridge();
    final backend = LibraryMusicApiBackend(
      bridge: bridge,
      readyEnsurer: () async {},
    );
    bridge.responses['/top/song'] = LibraryMusicResponse(
      headers: const {},
      body: const {
        'status': 1,
        'data': [
          {
            'hash': 'song-hash',
            'songname': 'Library Song',
            'authors': [
              {'author_id': 7, 'author_name': 'Library Singer'},
            ],
            'timelength': 180000,
            'audio_id': 99,
          },
        ],
      },
      status: 200,
    );

    final songs = await backend.getNewSongs();

    expect(songs, hasLength(1));
    expect(songs.single.name, 'Library Song');
    expect(songs.single.hash, 'song-hash');
    expect(songs.single.mixSongId, 99);
  });

  test(
    'LibraryMusicApiBackend getPlaylistTrackAll returns raw payload',
    () async {
      final bridge = _FakeKugouMusicApiBridge();
      final backend = LibraryMusicApiBackend(
        bridge: bridge,
        readyEnsurer: () async {},
      );
      bridge.responses['/playlist/track/all'] = LibraryMusicResponse(
        headers: const {},
        body: const {
          'status': 1,
          'data': {
            'songs': [
              {'hash': 'song-1'},
            ],
          },
        },
        status: 200,
      );

      final result = await backend.getPlaylistTrackAll('playlist-1', page: 2);

      expect(bridge.requests.single['route'], '/playlist/track/all');
      expect(bridge.requests.single['query'], {
        'id': 'playlist-1',
        'page': 2,
        'pagesize': 30,
      });
      expect(result, {
        'status': 1,
        'data': {
          'songs': [
            {'hash': 'song-1'},
          ],
        },
      });
    },
  );

  test(
    'LibraryMusicApiBackend userDetail returns data payload on success',
    () async {
      final bridge = _FakeKugouMusicApiBridge();
      final backend = LibraryMusicApiBackend(
        bridge: bridge,
        readyEnsurer: () async {},
      );
      bridge.responses['/user/detail'] = LibraryMusicResponse(
        headers: const {},
        body: const {
          'status': 1,
          'data': {'userid': 123, 'nickname': 'tester'},
        },
        status: 200,
      );

      final result = await backend.userDetail();

      expect(result, {'userid': 123, 'nickname': 'tester'});
    },
  );
}
