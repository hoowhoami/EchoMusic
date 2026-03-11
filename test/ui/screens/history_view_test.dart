import 'package:echomusic/models/song.dart';
import 'package:echomusic/providers/audio_provider.dart';
import 'package:echomusic/providers/navigation_provider.dart';
import 'package:echomusic/providers/persistence_provider.dart';
import 'package:echomusic/providers/refresh_provider.dart';
import 'package:echomusic/providers/selection_provider.dart';
import 'package:echomusic/providers/user_provider.dart';
import 'package:echomusic/ui/screens/history_view.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _FakeAudioProvider extends ChangeNotifier implements AudioProvider {
  int _playlistSessionId = 0;
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
  albumName: 'History Album',
  singers: [SingerInfo(id: 1, name: 'History Singer')],
  duration: 180,
  cover: '',
  mixSongId: 1,
  source: 'kugou',
);

Future<UserProvider> _buildAuthenticatedUser(
  PersistenceProvider persistence,
) async {
  await persistence.setUserInfo({'userid': 1, 'token': 'test-token'});
  return UserProvider()..setPersistenceProvider(persistence);
}

UserProvider _buildUnauthenticatedUser(PersistenceProvider persistence) {
  return UserProvider()..setPersistenceProvider(persistence);
}

Widget _buildApp({
  required AudioProvider audio,
  required NavigationProvider navigation,
  required PersistenceProvider persistence,
  required UserProvider user,
  required HistoryView child,
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
    'HistoryView defers remote loading until its root tab becomes active',
    (tester) async {
      SharedPreferences.setMockInitialValues({});
      final persistence = PersistenceProvider();
      final user = await _buildAuthenticatedUser(persistence);
      final audio = _FakeAudioProvider();
      final navigation = NavigationProvider();
      final calls = <String>[];
      addTearDown(user.dispose);
      addTearDown(audio.dispose);
      addTearDown(navigation.dispose);

      await tester.pumpWidget(
        _buildApp(
          audio: audio,
          navigation: navigation,
          persistence: persistence,
          user: user,
          child: HistoryView(
            fetchHistoryPage: (bp) async {
              calls.add(bp ?? 'first');
              if (bp == null) {
                return {
                  'songs': [_song('第一页历史', 'history-1')],
                  'bp': 'bp-1',
                  'has_more': true,
                };
              }
              if (bp == 'bp-1') {
                return {
                  'songs': [_song('第二页历史', 'history-2')],
                  'bp': null,
                  'has_more': false,
                };
              }
              return {'songs': <Song>[], 'bp': null, 'has_more': false};
            },
          ),
        ),
      );
      await tester.pump();

      expect(calls, isEmpty);

      navigation.navigateToRoot(3);
      await tester.pumpAndSettle();

      expect(calls, ['first', 'bp-1']);
      expect(find.text('最近播放'), findsOneWidget);
      expect(find.text('第一页历史'), findsOneWidget);
      expect(find.text('第二页历史'), findsOneWidget);
      expect(find.text('播放'), findsOneWidget);

      navigation.navigateToRoot(0);
      await tester.pumpAndSettle();
      navigation.navigateToRoot(3);
      await tester.pumpAndSettle();

      expect(calls, ['first', 'bp-1', 'first', 'bp-1']);
    },
  );

  testWidgets(
    'HistoryView shows local history immediately when unauthenticated',
    (tester) async {
      SharedPreferences.setMockInitialValues({});
      final persistence = PersistenceProvider();
      await persistence.addToHistory(_song('本地历史歌曲', 'local-history-1'));
      final user = _buildUnauthenticatedUser(persistence);
      final audio = _FakeAudioProvider();
      final navigation = NavigationProvider()..navigateToRoot(3);
      var requestCount = 0;
      addTearDown(user.dispose);
      addTearDown(audio.dispose);
      addTearDown(navigation.dispose);

      await tester.pumpWidget(
        _buildApp(
          audio: audio,
          navigation: navigation,
          persistence: persistence,
          user: user,
          child: HistoryView(
            fetchHistoryPage: (bp) async {
              requestCount++;
              return {'songs': <Song>[], 'bp': null, 'has_more': false};
            },
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(requestCount, 0);
      expect(find.text('本地历史歌曲'), findsOneWidget);
      expect(find.text('当前展示本地播放历史'), findsOneWidget);
    },
  );
}
