import 'package:echomusic/models/song.dart';
import 'package:echomusic/providers/audio_provider.dart';
import 'package:echomusic/providers/navigation_provider.dart';
import 'package:echomusic/providers/persistence_provider.dart';
import 'package:echomusic/providers/refresh_provider.dart';
import 'package:echomusic/providers/selection_provider.dart';
import 'package:echomusic/providers/user_provider.dart';
import 'package:echomusic/ui/screens/cloud_view.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _FakeAudioProvider extends ChangeNotifier implements AudioProvider {
  int playSongCallCount = 0;
  int _playlistSessionId = 0;
  Song? lastPlayedSong;
  List<Song> _playlist = const <Song>[];

  @override
  Song get currentSong =>
      _playlist.isNotEmpty ? _playlist.first : _song('Current', 'current');
  @override
  bool get isPlaying => false;
  @override
  bool get isLoading => false;
  @override
  List<Song> get playlist => _playlist;
  @override
  int get currentIndex => _playlist.isEmpty ? -1 : 0;
  @override
  int get playlistSessionId => _playlistSessionId;
  @override
  int get activePlaylistFilteredInvalidSongCount => 0;

  @override
  Future<void> playSong(Song song, {List<Song>? playlist}) async {
    playSongCallCount++;
    lastPlayedSong = song;
    _playlist = List<Song>.from(playlist ?? <Song>[song]);
    _playlistSessionId++;
    notifyListeners();
  }

  @override
  bool appendSongsToActivePlaylist(List<Song> songs, {required int sessionId}) {
    if (sessionId != _playlistSessionId) return false;
    _playlist = <Song>[..._playlist, ...songs];
    notifyListeners();
    return true;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

Song _song(String name, String hash) => Song(
  hash: hash,
  name: name,
  albumName: 'Cloud Album',
  singers: [SingerInfo(id: 1, name: 'Cloud Singer')],
  duration: 180,
  cover: '',
  mixSongId: 1,
  source: 'cloud',
);

Future<UserProvider> _buildUser(PersistenceProvider persistence) async {
  await persistence.setUserInfo({'userid': 1, 'token': 'test-token'});
  return UserProvider()..setPersistenceProvider(persistence);
}

Widget _buildApp({
  required AudioProvider audio,
  required NavigationProvider navigation,
  required PersistenceProvider persistence,
  required UserProvider user,
  required CloudView child,
}) {
  return MultiProvider(
    providers: [
      ChangeNotifierProvider<RefreshProvider>(create: (_) => RefreshProvider()),
      ChangeNotifierProvider<AudioProvider>.value(value: audio),
      ChangeNotifierProvider<PersistenceProvider>.value(value: persistence),
      ChangeNotifierProvider<UserProvider>.value(value: user),
      ChangeNotifierProvider<NavigationProvider>.value(value: navigation),
      ChangeNotifierProvider<SelectionProvider>(
        create: (_) => SelectionProvider(),
      ),
    ],
    child: MaterialApp(
      home: Scaffold(body: SizedBox(width: 960, height: 900, child: child)),
    ),
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets(
    'CloudView loads remaining songs in background and shows play action',
    (tester) async {
      SharedPreferences.setMockInitialValues({});
      final persistence = PersistenceProvider();
      final user = await _buildUser(persistence);
      final audio = _FakeAudioProvider();
      final navigation = NavigationProvider();
      final calls = <int>[];
      addTearDown(user.dispose);
      addTearDown(audio.dispose);
      addTearDown(navigation.dispose);

      await tester.pumpWidget(
        _buildApp(
          audio: audio,
          navigation: navigation,
          persistence: persistence,
          user: user,
          child: CloudView(
            fetchSongsPage: (page, pageSize) async {
              calls.add(page);
              if (page == 1) {
                return {
                  'songs': [_song('第一页歌曲', 'cloud-1')],
                  'count': 2,
                  'capacity': 1024,
                  'available': 512,
                };
              }
              if (page == 2) {
                return {
                  'songs': [_song('第二页歌曲', 'cloud-2')],
                  'count': 2,
                  'capacity': 1024,
                  'available': 512,
                };
              }
              return {
                'songs': <Song>[],
                'count': 2,
                'capacity': 1024,
                'available': 512,
              };
            },
          ),
        ),
      );
      await tester.pump();

      expect(calls, isEmpty);

      navigation.navigateToRoot(4);
      await tester.pumpAndSettle();

      expect(calls, [1, 2]);
      expect(find.text('音乐云盘'), findsOneWidget);
      expect(find.text('播放'), findsOneWidget);
      expect(find.text('第一页歌曲'), findsOneWidget);
      expect(find.text('第二页歌曲'), findsOneWidget);

      navigation.navigateToRoot(0);
      await tester.pumpAndSettle();
      navigation.navigateToRoot(4);
      await tester.pumpAndSettle();

      expect(calls, [1, 2, 1, 2]);
    },
  );

  testWidgets('CloudView play button starts playback with cloud songs', (
    tester,
  ) async {
    SharedPreferences.setMockInitialValues({});
    final persistence = PersistenceProvider();
    final user = await _buildUser(persistence);
    final audio = _FakeAudioProvider();
    final navigation = NavigationProvider()..navigateToRoot(4);
    addTearDown(user.dispose);
    addTearDown(audio.dispose);
    addTearDown(navigation.dispose);

    await tester.pumpWidget(
      _buildApp(
        audio: audio,
        navigation: navigation,
        persistence: persistence,
        user: user,
        child: CloudView(
          fetchSongsPage: (page, pageSize) async => {
            'songs': page == 1 ? [_song('可播放云盘歌曲', 'cloud-play')] : <Song>[],
            'count': 1,
            'capacity': 2048,
            'available': 1024,
          },
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.text('播放'));
    await tester.pump();

    expect(audio.playSongCallCount, 1);
    expect(audio.lastPlayedSong?.name, '可播放云盘歌曲');
    expect(audio.playlist, hasLength(1));
  });
}
