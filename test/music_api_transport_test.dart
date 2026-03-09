import 'package:dio/dio.dart';
import 'package:echomusic/api/music_api.dart';
import 'package:echomusic/api/transport/music_transport.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _RecordedRequest {
  const _RecordedRequest({
    required this.path,
    this.queryParameters,
    this.options,
  });

  final String path;
  final Map<String, dynamic>? queryParameters;
  final Options? options;
}

class _FakeMusicTransport implements MusicTransport {
  final List<_RecordedRequest> requests = [];
  final Map<String, Response<dynamic>> _responses = {};

  void stubGet(String path, dynamic data, {int? statusCode}) {
    _responses[path] = Response<dynamic>(
      data: data,
      statusCode: statusCode,
      requestOptions: RequestOptions(path: path),
    );
  }

  @override
  Future<Response<dynamic>> get(
    String path, {
    Map<String, dynamic>? queryParameters,
    Options? options,
  }) async {
    requests.add(
      _RecordedRequest(
        path: path,
        queryParameters: queryParameters,
        options: options,
      ),
    );

    final response = _responses[path];
    if (response == null) {
      throw StateError('No fake response configured for $path');
    }

    return Response<dynamic>(
      data: response.data,
      statusCode: response.statusCode,
      requestOptions: RequestOptions(
        path: path,
        queryParameters: queryParameters ?? const {},
      ),
    );
  }

  @override
  Future<void> ensureReady() async {}

  @override
  Future<void> dispose() async {}
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() async {
    SharedPreferences.setMockInitialValues({});
    await MusicApi.resetTransport();
  });

  tearDown(() async {
    await MusicApi.resetTransport();
  });

  test('registerDevice keeps skipAuth option when using transport', () async {
    final transport = _FakeMusicTransport()
      ..stubGet('/register/dev', {
        'status': 1,
        'data': {'dfid': 'device-1'},
      });
    await MusicApi.setTransport(transport);

    final result = await MusicApi.registerDevice();

    expect(result, isNotNull);
    expect(result?['dfid'], 'device-1');
    expect(transport.requests, hasLength(1));
    expect(transport.requests.single.path, '/register/dev');
    final options = transport.requests.single.options;
    expect(options, isNotNull);
    expect(options!.extra?['skipAuth'], isTrue);
  });

  test(
    'getSongUrl delegates route and query parameters through transport',
    () async {
      final transport = _FakeMusicTransport()
        ..stubGet('/song/url', {
          'status': 1,
          'data': {
            'url': ['https://example.com/song.mp3'],
          },
        });
      await MusicApi.setTransport(transport);

      final result = await MusicApi.getSongUrl('hash-123', quality: '320');

      expect(result, isNotNull);
      expect(result?['url'], 'https://example.com/song.mp3');
      expect(result?['status'], 1);
      expect(transport.requests, hasLength(1));
      expect(transport.requests.single.path, '/song/url');
      expect(transport.requests.single.queryParameters, {
        'hash': 'hash-123',
        'quality': '320',
      });
    },
  );

  test('getNewSongs parses song list from transport response', () async {
    final transport = _FakeMusicTransport()
      ..stubGet('/top/song', {
        'status': 1,
        'data': [
          {
            'hash': 'song-hash',
            'songname': 'Transport Song',
            'album_name': 'Transport Album',
            'authors': [
              {'author_id': 7, 'author_name': 'Transport Singer'},
            ],
            'timelength': 180000,
            'cover': 'https://example.com/cover.jpg',
            'audio_id': 99,
          },
        ],
      });
    await MusicApi.setTransport(transport);

    final songs = await MusicApi.getNewSongs();

    expect(songs, hasLength(1));
    expect(songs.single.hash, 'song-hash');
    expect(songs.single.name, 'Transport Song');
    expect(songs.single.mixSongId, 99);
    expect(songs.single.singers.single.name, 'Transport Singer');
    expect(transport.requests.single.path, '/top/song');
  });
}
