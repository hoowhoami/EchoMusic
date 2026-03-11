import 'dart:async';
import 'package:flutter/gestures.dart';

import 'package:echomusic/api/music_api.dart';
import 'package:echomusic/models/playlist.dart';
import 'package:echomusic/providers/audio_provider.dart';
import 'package:echomusic/providers/navigation_provider.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:echomusic/models/song.dart';
import 'package:echomusic/providers/persistence_provider.dart';
import 'package:echomusic/providers/user_provider.dart';
import 'package:echomusic/ui/screens/playlist_detail_view.dart';
import 'package:echomusic/ui/widgets/app_shortcuts.dart';
import 'package:echomusic/ui/widgets/cover_image.dart';
import 'package:echomusic/ui/widgets/detail_page_action_row.dart';
import 'package:echomusic/ui/widgets/player_bar.dart';
import 'package:echomusic/ui/widgets/queue_drawer.dart';
import 'package:echomusic/ui/widgets/song_card.dart';
import 'package:echomusic/ui/widgets/song_list.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import 'package:echomusic/providers/selection_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _FakeAudioProvider extends ChangeNotifier implements AudioProvider {
  _FakeAudioProvider({
    required Song currentSong,
    required double initialVolume,
    bool isPlaying = false,
    bool isLoading = false,
    List<Song> playlist = const [],
    int currentIndex = -1,
    int activePlaylistFilteredInvalidSongCount = 0,
  }) : _currentSong = currentSong,
       _isPlaying = isPlaying,
       _isLoading = isLoading,
       _playlist = playlist,
       _currentIndex = currentIndex,
       _activePlaylistFilteredInvalidSongCount =
           activePlaylistFilteredInvalidSongCount,
       _displayVolume = initialVolume,
       _lastAudibleVolume = initialVolume > 0 ? initialVolume : 50.0;

  final StreamController<double> _userVolumeController =
      StreamController<double>.broadcast();
  final StreamController<PositionSnapshot> _positionController =
      StreamController<PositionSnapshot>.broadcast();
  final Song _currentSong;
  final bool _isPlaying;
  final bool _isLoading;
  final List<Song> _playlist;
  final int _currentIndex;
  final int _activePlaylistFilteredInvalidSongCount;
  double _displayVolume;
  double _lastAudibleVolume;
  int playSongCallCount = 0;
  int queueAndPlaySongCallCount = 0;
  int addSongToPlayNextCallCount = 0;
  int togglePlayCallCount = 0;
  Song? lastPlayedSong;
  List<Song>? lastPlayedPlaylist;
  Song? queuedSong;
  Song? nextQueuedSong;

  @override
  Song? get currentSong => _currentSong;

  @override
  bool get isPlaying => _isPlaying;

  @override
  bool get isLoading => _isLoading;

  @override
  String get playMode => 'repeat';

  @override
  double get playbackRate => 1.0;

  @override
  Map<double, double> get climaxMarks => const {};

  @override
  Stream<PositionSnapshot> get positionSnapshotStream =>
      _positionController.stream;

  @override
  Duration get effectivePosition => Duration.zero;

  @override
  Duration get effectiveDuration => const Duration(minutes: 3);

  @override
  Stream<double> get userVolumeStream => _userVolumeController.stream;

  @override
  double get displayVolume => _displayVolume;

  @override
  List<Song> get playlist => _playlist;

  @override
  int get currentIndex => _currentIndex;

  @override
  int get activePlaylistFilteredInvalidSongCount =>
      _activePlaylistFilteredInvalidSongCount;

  @override
  Future<void> playSong(Song song, {List<Song>? playlist}) async {
    playSongCallCount++;
    lastPlayedSong = song;
    lastPlayedPlaylist = playlist;
  }

  @override
  Future<void> queueAndPlaySong(Song song) async {
    queueAndPlaySongCallCount++;
    queuedSong = song;
  }

  @override
  bool addSongToPlayNext(Song song) {
    addSongToPlayNextCallCount++;
    nextQueuedSong = song;
    return true;
  }

  @override
  void previous() {}

  @override
  void next() {}

  @override
  void togglePlay() {
    togglePlayCallCount++;
  }

  @override
  void setPlayMode(String mode) {}

  @override
  void setPlaybackRate(double rate) {}

  @override
  void notifyDragStart() {}

  @override
  void notifyDragEnd() {}

  @override
  Future<void> seek(Duration duration) async {}

  @override
  void setVolume(double volume) {
    _displayVolume = volume;
    if (volume > 0) {
      _lastAudibleVolume = volume;
    }
    _userVolumeController.add(volume);
  }

  @override
  void toggleMute() {
    if (_displayVolume > 0) {
      _lastAudibleVolume = _displayVolume;
      _displayVolume = 0;
    } else {
      _displayVolume = _lastAudibleVolume;
    }
    _userVolumeController.add(_displayVolume);
  }

  @override
  void dispose() {
    _userVolumeController.close();
    _positionController.close();
    super.dispose();
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FakePersistenceProvider extends ChangeNotifier
    implements PersistenceProvider {
  _FakePersistenceProvider({Set<String> favoriteHashes = const {}})
    : _favoriteHashes = favoriteHashes
          .map((hash) => hash.toLowerCase())
          .toSet();

  final Set<String> _favoriteHashes;
  int toggleFavoriteCallCount = 0;

  @override
  bool isFavorite(Song song) {
    return song.hash.isNotEmpty &&
        _favoriteHashes.contains(song.hash.toLowerCase());
  }

  @override
  Future<void> toggleFavorite(Song song, {dynamic userProvider}) async {
    toggleFavoriteCallCount++;
    final normalizedHash = song.hash.toLowerCase();
    if (normalizedHash.isEmpty) return;
    if (_favoriteHashes.contains(normalizedHash)) {
      _favoriteHashes.remove(normalizedHash);
    } else {
      _favoriteHashes.add(normalizedHash);
    }
    notifyListeners();
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FakeNavigationProvider extends ChangeNotifier
    implements NavigationProvider {
  int openSongDetailCallCount = 0;
  int openSongCommentCallCount = 0;
  Song? lastDetailSong;
  Song? lastCommentSong;

  @override
  String get currentRefreshKey => 'fake-root';

  @override
  void openSongDetail(Song song) {
    openSongDetailCallCount++;
    lastDetailSong = song;
  }

  @override
  void openSongComment(Song song) {
    openSongCommentCallCount++;
    lastCommentSong = song;
  }

  @override
  bool isCurrentRoute(String routeName, {int? id}) => false;

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

class _FakeSelectionProvider extends ChangeNotifier
    implements SelectionProvider {
  _FakeSelectionProvider({
    this.selectionMode = false,
    Set<String> selectedHashes = const <String>{},
  }) : _selectedHashes = Set<String>.from(selectedHashes);

  final bool selectionMode;
  final Set<String> _selectedHashes;

  @override
  bool get isSelectionMode => selectionMode;

  @override
  bool isSelected(String hash) {
    return hash.isNotEmpty && _selectedHashes.contains(hash);
  }

  @override
  void toggleSelection(String hash) {
    if (hash.isEmpty) return;
    if (_selectedHashes.contains(hash)) {
      _selectedHashes.remove(hash);
    } else {
      _selectedHashes.add(hash);
    }
    notifyListeners();
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  Song buildSong({
    required String name,
    String hash = '',
    int mixSongId = 0,
    int? fileId,
    String albumName = 'Album',
    String singerName = 'Singer',
    int duration = 180,
    String? albumId,
    String? source,
  }) {
    return Song(
      hash: hash,
      name: name,
      albumName: albumName,
      albumId: albumId,
      singers: [SingerInfo(id: 1, name: singerName)],
      duration: duration,
      cover: '',
      mixSongId: mixSongId,
      fileId: fileId,
      source: source,
    );
  }

  test('Song exposes playability based on hash', () {
    final playableSong = buildSong(name: 'Playable', hash: 'ABC123');
    final unavailableSong = buildSong(name: 'Unavailable');

    expect(playableSong.isPlayable, isTrue);
    expect(unavailableSong.isPlayable, isFalse);
  });

  test('AppShortcuts no longer binds bare space for playback', () {
    final playbackInfo = AppShortcuts.shortcutInfos.firstWhere(
      (info) => info.command == AppShortcutCommand.togglePlayback,
    );
    final bareSpace = const SingleActivator(LogicalKeyboardKey.space);

    expect(
      AppShortcuts.shortcutsFor(DesktopShortcutPlatform.windows).keys,
      isNot(contains(bareSpace)),
    );
    expect(
      AppShortcuts.shortcutsFor(DesktopShortcutPlatform.macOS).keys,
      isNot(contains(bareSpace)),
    );
    expect(playbackInfo.description.contains('Space'), isFalse);
  });

  test('Song display metadata normalizes underscores for UI', () {
    final song = Song(
      hash: 'meta-hash',
      name: 'Meta Song',
      albumName: 'Album__Name',
      singers: [
        SingerInfo(id: 1, name: 'Singer_One'),
        SingerInfo(id: 2, name: 'Singer__Two'),
      ],
      duration: 180,
      cover: '',
      mixSongId: 0,
    );

    expect(Song.normalizeDisplayText('A__B___C'), 'A B C');
    expect(song.displaySingerName, 'Singer One, Singer Two');
    expect(song.displayAlbumName, 'Album Name');
  });

  test('SelectionProvider selects songs by hash and ignores empty hash', () {
    final provider = SelectionProvider();
    final firstSong = buildSong(name: 'Song A', hash: 'hash-a');
    final secondSong = buildSong(name: 'Song B');
    final thirdSong = buildSong(name: 'Song C', hash: 'hash-c');

    provider.setSongList([firstSong, secondSong, thirdSong]);
    provider.enterSelectionMode();
    provider.toggleSelection(firstSong.hash);
    provider.toggleSelection(secondSong.hash);

    expect(provider.selectedSongs, [firstSong]);
    expect(provider.isSelected(firstSong.hash), isTrue);
    expect(provider.isSelected(secondSong.hash), isFalse);

    provider.selectAll();

    expect(provider.selectedSongs, containsAll([firstSong, thirdSong]));
    expect(provider.selectedCount, 2);
  });

  test(
    'Song.fromPlaylistJson falls back to filename and trans_param cover',
    () {
      final song = Song.fromPlaylistJson({
        'filename': '周杰伦 - 晴天.flac',
        'timelen': 245000,
        'trans_param': {
          'union_cover': 'https://img.example.com/{size}/cover.jpg',
        },
      });

      expect(song.name, '晴天');
      expect(song.singerName, '周杰伦');
      expect(song.cover, 'https://img.example.com/400/cover.jpg');
      expect(song.duration, 245);
    },
  );

  test(
    'Song.fromPlaylistJson falls back to audio_info and album_info metadata',
    () {
      final song = Song.fromPlaylistJson({
        'audio_info': {
          'songname': '备用歌曲名',
          'author_name': '备用歌手',
          'duration_128': 180000,
          'audio_id': 12345,
        },
        'album_info': {
          'album_name': '备用专辑',
          'album_id': 67890,
          'sizable_cover': 'https://cdn.example.com/{size}/album.jpg',
        },
      });

      expect(song.name, '备用歌曲名');
      expect(song.singerName, '备用歌手');
      expect(song.albumName, '备用专辑');
      expect(song.albumId, '67890');
      expect(song.cover, 'https://cdn.example.com/400/album.jpg');
      expect(song.mixSongId, 12345);
      expect(song.duration, 180);
    },
  );

  test(
    'MusicApi filters meaningless hashless shell items and reports count',
    () {
      final result = MusicApi.parsePlaylistSongsFromResponse({
        'data': {
          'songs': [
            {
              'hash': 'abc123',
              'songname': '正常歌曲',
              'author_name': '歌手A',
              'timelen': 180000,
            },
            {'shield': 1, 'fileid': 383},
          ],
        },
      });

      expect(result.filteredCount, 1);
      expect(result.sourceCount, 2);
      expect(result.songs, hasLength(1));
      expect(result.songs.first.name, '正常歌曲');
    },
  );

  test(
    'PersistenceProvider persists playlist filtered invalid-song count',
    () async {
      SharedPreferences.setMockInitialValues({});

      final song = buildSong(
        name: 'Persisted Song',
        hash: 'persisted-hash',
        mixSongId: 123,
        albumName: 'Persisted Album',
        albumId: '456',
        source: 'cloud',
      );
      final provider = PersistenceProvider();
      await Future<void>.delayed(Duration.zero);

      await provider.savePlaybackState([song], 0, filteredInvalidSongCount: 7);

      final restored = PersistenceProvider();
      await Future<void>.delayed(Duration.zero);

      expect(restored.playlist, hasLength(1));
      expect(restored.currentIndex, 0);
      expect(restored.playlistFilteredInvalidSongCount, 7);
      expect(restored.playlist.first.name, 'Persisted Song');
      expect(restored.playlist.first.albumName, 'Persisted Album');
      expect(restored.playlist.first.albumId, '456');
      expect(restored.playlist.first.source, 'cloud');
    },
  );

  test(
    'PersistenceProvider removes legacy addSongsToPlaylist setting',
    () async {
      SharedPreferences.setMockInitialValues({
        'app_settings': '{"addSongsToPlaylist":true,"replacePlaylist":true}',
      });

      final provider = PersistenceProvider();
      await Future<void>.delayed(Duration.zero);

      expect(provider.settings.containsKey('addSongsToPlaylist'), isFalse);
      expect(provider.settings['replacePlaylist'], isTrue);
    },
  );

  test(
    'MusicApi preserves route-provided playlist track id for owned playlists',
    () async {
      SharedPreferences.setMockInitialValues({'user_info': '{"userid":1}'});

      final ownPlaylistId = await MusicApi.resolvePlaylistTrackQueryId(
        'collection_3_2025543655_273_0',
        listid: 273,
        listCreateUserid: 1,
        listCreateGid: 'collection_3_2025543655_273_0',
      );

      expect(ownPlaylistId, 'collection_3_2025543655_273_0');
    },
  );

  test('PlaylistDetailRouteArgs snapshots playlist query parameters', () {
    final playlist = Playlist(
      id: 273,
      name: 'Snapshot Playlist',
      pic: '',
      intro: '',
      playCount: 0,
      count: 12,
      nickname: 'tester',
      globalCollectionId: 'collection_3_2025543655_273_0',
      listid: 998,
      listCreateGid: 'creator_gid_998',
      listCreateUserid: 2,
    );

    final args = PlaylistDetailRouteArgs.fromPlaylist(playlist);

    expect(args.playlist, same(playlist));
    expect(args.playlistId, 273);
    expect(args.lookupId, 'collection_3_2025543655_273_0');
    expect(args.trackListId, 998);
    expect(args.trackListCreateGid, 'creator_gid_998');
    expect(args.trackListCreateUserid, 2);
  });

  testWidgets('PlayerBar volume popup reopens with muted volume state', (
    tester,
  ) async {
    tester.view.physicalSize = const Size(1600, 900);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });

    SharedPreferences.setMockInitialValues({
      'player_settings':
          '{"volume":50.0,"playMode":"repeat","audioQuality":"sq","audioEffect":"none"}',
    });

    final persistence = PersistenceProvider();
    final audio = _FakeAudioProvider(
      currentSong: buildSong(name: 'Muted Song', hash: 'muted-hash'),
      initialVolume: 40,
    );

    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<AudioProvider>.value(value: audio),
          ChangeNotifierProvider<PersistenceProvider>.value(value: persistence),
          ChangeNotifierProvider<NavigationProvider>(
            create: (_) => NavigationProvider(),
          ),
          ChangeNotifierProvider<UserProvider>(create: (_) => UserProvider()),
        ],
        child: const MaterialApp(home: Scaffold(body: PlayerBar())),
      ),
    );
    await tester.pump();

    final volumeTooltip =
        '音量：${AppShortcuts.labelFor(AppShortcutCommand.volumeUp)} / '
        '${AppShortcuts.labelFor(AppShortcutCommand.volumeDown)} / '
        '${AppShortcuts.labelFor(AppShortcutCommand.toggleMute)}';

    await tester.tap(find.byTooltip(volumeTooltip));
    await tester.pumpAndSettle();

    expect(find.text('40%'), findsOneWidget);

    await tester.tapAt(const Offset(5, 5));
    await tester.pumpAndSettle();

    audio.toggleMute();
    await tester.pump();

    await tester.tap(find.byTooltip(volumeTooltip));
    await tester.pumpAndSettle();

    expect(find.text('0%'), findsOneWidget);
    expect(find.byIcon(CupertinoIcons.speaker_slash_fill), findsWidgets);
    expect(find.text('50%'), findsNothing);
  });

  testWidgets(
    'PlayerBar favorite actions stay left of centered playback controls on wide windows',
    (tester) async {
      tester.view.physicalSize = const Size(1600, 900);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      SharedPreferences.setMockInitialValues({});

      final song = buildSong(
        name: 'Wide Window Song',
        hash: 'wide-window-hash',
      );
      final persistence = PersistenceProvider();
      await persistence.setUserInfo({'userid': 1, 'token': 'test-token'});

      final audio = _FakeAudioProvider(currentSong: song, initialVolume: 40);
      final user = UserProvider()..setPersistenceProvider(persistence);
      addTearDown(audio.dispose);
      addTearDown(user.dispose);

      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider<AudioProvider>.value(value: audio),
            ChangeNotifierProvider<PersistenceProvider>.value(
              value: persistence,
            ),
            ChangeNotifierProvider<NavigationProvider>(
              create: (_) => NavigationProvider(),
            ),
            ChangeNotifierProvider<UserProvider>.value(value: user),
          ],
          child: const MaterialApp(home: Scaffold(body: PlayerBar())),
        ),
      );
      await tester.pumpAndSettle();

      final favoriteTooltip =
          '收藏 · ${AppShortcuts.labelFor(AppShortcutCommand.toggleFavorite)}';
      final playTooltip =
          '播放 · ${AppShortcuts.labelFor(AppShortcutCommand.togglePlayback)}';

      final favoriteRect = tester.getRect(find.byTooltip(favoriteTooltip));
      final playRect = tester.getRect(find.byTooltip(playTooltip));

      expect(favoriteRect.right, lessThan(playRect.left));
    },
  );

  testWidgets(
    'SongList locate button does not scroll when current song is already visible',
    (tester) async {
      final songs = List.generate(
        12,
        (index) => buildSong(name: 'Song $index', hash: 'song-hash-$index'),
      );
      final audio = _FakeAudioProvider(
        currentSong: songs[4],
        initialVolume: 40,
      );
      addTearDown(audio.dispose);

      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider<AudioProvider>.value(value: audio),
            ChangeNotifierProvider<PersistenceProvider>.value(
              value: _FakePersistenceProvider(),
            ),
            ChangeNotifierProvider<NavigationProvider>.value(
              value: _FakeNavigationProvider(),
            ),
            ChangeNotifierProvider<SelectionProvider>.value(
              value: _FakeSelectionProvider(),
            ),
          ],
          child: MaterialApp(
            home: Scaffold(
              body: SizedBox(height: 360, child: SongList(songs: songs)),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.drag(find.byType(CustomScrollView), const Offset(0, -120));
      await tester.pumpAndSettle();

      final scrollable = tester.state<ScrollableState>(
        find.byType(Scrollable).first,
      );
      final beforeOffset = scrollable.position.pixels;
      expect(beforeOffset, greaterThan(0));

      await tester.tap(find.byIcon(CupertinoIcons.scope));
      await tester.pumpAndSettle();

      expect(scrollable.position.pixels, closeTo(beforeOffset, 0.1));
    },
  );

  testWidgets('SongList shows songs tab, search and sticky sortable header', (
    tester,
  ) async {
    final songs = List.generate(
      3,
      (index) =>
          buildSong(name: 'Header Song $index', hash: 'header-song-$index'),
    );
    final audio = _FakeAudioProvider(currentSong: songs[0], initialVolume: 40);
    addTearDown(audio.dispose);

    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<AudioProvider>.value(value: audio),
          ChangeNotifierProvider<PersistenceProvider>.value(
            value: _FakePersistenceProvider(),
          ),
          ChangeNotifierProvider<NavigationProvider>.value(
            value: _FakeNavigationProvider(),
          ),
          ChangeNotifierProvider<SelectionProvider>.value(
            value: _FakeSelectionProvider(),
          ),
        ],
        child: MaterialApp(
          home: Scaffold(
            body: SizedBox(
              width: 960,
              height: 360,
              child: SongList(songs: songs),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final countBadge = find.byKey(const ValueKey('song-list-tab-count-badge'));

    expect(countBadge, findsOneWidget);
    expect(
      find.descendant(of: countBadge, matching: find.text('3')),
      findsOneWidget,
    );
    expect(find.widgetWithText(InkWell, '#'), findsOneWidget);
    expect(find.widgetWithText(InkWell, '专辑'), findsOneWidget);
    expect(find.widgetWithText(InkWell, '时长'), findsOneWidget);
    expect(find.byTooltip('定位当前播放'), findsOneWidget);
    expect(find.text('搜索列表内歌曲'), findsOneWidget);
    expect(find.textContaining('匹配 '), findsNothing);

    await tester.enterText(find.byType(TextField), 'Header Song 1');
    await tester.pumpAndSettle();

    expect(
      find.descendant(of: countBadge, matching: find.text('1 / 3')),
      findsOneWidget,
    );
    expect(find.textContaining('匹配 '), findsNothing);

    await tester.drag(find.byType(CustomScrollView), const Offset(0, -240));
    await tester.pumpAndSettle();

    final durationHeader = find.widgetWithText(InkWell, '时长');
    expect(durationHeader, findsOneWidget);
    expect(tester.getTopLeft(durationHeader).dy, lessThan(120));
  });

  testWidgets('SongList sorts songs by duration and resets on third tap', (
    tester,
  ) async {
    final songs = [
      buildSong(name: 'Long Song', hash: 'long-song', duration: 240),
      buildSong(name: 'Short Song', hash: 'short-song', duration: 120),
      buildSong(name: 'Mid Song', hash: 'mid-song', duration: 180),
    ];
    final audio = _FakeAudioProvider(currentSong: songs[0], initialVolume: 40);
    addTearDown(audio.dispose);

    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<AudioProvider>.value(value: audio),
          ChangeNotifierProvider<PersistenceProvider>.value(
            value: _FakePersistenceProvider(),
          ),
          ChangeNotifierProvider<NavigationProvider>.value(
            value: _FakeNavigationProvider(),
          ),
          ChangeNotifierProvider<SelectionProvider>.value(
            value: _FakeSelectionProvider(),
          ),
        ],
        child: MaterialApp(
          home: Scaffold(
            body: SizedBox(
              width: 960,
              height: 360,
              child: SongList(songs: songs),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final durationHeader = find.widgetWithText(InkWell, '时长');
    await tester.tap(durationHeader);
    await tester.pumpAndSettle();

    expect(
      tester.getTopLeft(find.text('Short Song')).dy,
      lessThan(tester.getTopLeft(find.text('Mid Song')).dy),
    );
    expect(
      tester.getTopLeft(find.text('Mid Song')).dy,
      lessThan(tester.getTopLeft(find.text('Long Song')).dy),
    );

    await tester.tap(durationHeader);
    await tester.pumpAndSettle();

    expect(
      tester.getTopLeft(find.text('Long Song')).dy,
      lessThan(tester.getTopLeft(find.text('Mid Song')).dy),
    );
    expect(
      tester.getTopLeft(find.text('Mid Song')).dy,
      lessThan(tester.getTopLeft(find.text('Short Song')).dy),
    );

    await tester.tap(durationHeader);
    await tester.pumpAndSettle();

    expect(
      tester.getTopLeft(find.text('Long Song')).dy,
      lessThan(tester.getTopLeft(find.text('Short Song')).dy),
    );
    expect(
      tester.getTopLeft(find.text('Short Song')).dy,
      lessThan(tester.getTopLeft(find.text('Mid Song')).dy),
    );
  });

  testWidgets('DetailPageActionRow keeps action buttons at 36 height', (
    tester,
  ) async {
    final song = buildSong(name: 'Action Song', hash: 'action-song');

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: DetailPageActionRow(
            playLabel: '播放',
            onPlay: () {},
            songs: [song],
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final playButton = find.ancestor(
      of: find.text('播放'),
      matching: find.byWidgetPredicate(
        (widget) => widget is FilledButton,
        description: 'FilledButton',
      ),
    );
    final batchButton = find.ancestor(
      of: find.text('批量'),
      matching: find.byWidgetPredicate(
        (widget) => widget is FilledButton,
        description: 'FilledButton',
      ),
    );

    expect(tester.getSize(playButton.first).height, 36);
    expect(tester.getSize(batchButton.first).height, 36);
  });

  testWidgets(
    'QueueDrawer does not auto-scroll when current song is already visible',
    (tester) async {
      final songs = List.generate(
        8,
        (index) => buildSong(
          name: 'Queue Song $index',
          hash: 'queue-song-hash-$index',
        ),
      );
      final audio = _FakeAudioProvider(
        currentSong: songs[1],
        initialVolume: 40,
        playlist: songs,
        currentIndex: 1,
      );
      addTearDown(audio.dispose);

      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider<AudioProvider>.value(value: audio),
          ],
          child: const MaterialApp(
            home: Scaffold(
              body: SizedBox(width: 420, height: 520, child: QueueDrawer()),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      final scrollable = tester.state<ScrollableState>(
        find.byType(Scrollable).first,
      );
      expect(scrollable.position.pixels, 0);
    },
  );

  testWidgets('SongCard row tap does not start playback but play button does', (
    tester,
  ) async {
    final song = buildSong(name: 'Row Tap Song', hash: 'row-tap-hash');
    final persistence = _FakePersistenceProvider();
    final navigation = _FakeNavigationProvider();
    final selection = _FakeSelectionProvider();
    final audio = _FakeAudioProvider(
      currentSong: buildSong(name: 'Other Song', hash: 'other-song-hash'),
      initialVolume: 40,
    );
    addTearDown(audio.dispose);

    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<AudioProvider>.value(value: audio),
          ChangeNotifierProvider<PersistenceProvider>.value(value: persistence),
          ChangeNotifierProvider<NavigationProvider>.value(value: navigation),
          ChangeNotifierProvider<SelectionProvider>.value(value: selection),
        ],
        child: MaterialApp(
          home: Scaffold(
            body: SongCard(
              song: song,
              playlist: [song],
              showCover: true,
              showMore: false,
            ),
          ),
        ),
      ),
    );
    await tester.pump();

    final rowInkWell = tester
        .widgetList<InkWell>(
          find.descendant(
            of: find.byType(SongCard),
            matching: find.byType(InkWell),
          ),
        )
        .singleWhere(
          (inkWell) => inkWell.onTap == null && inkWell.onDoubleTap == null,
        );

    expect(rowInkWell.onTap, isNull);
    expect(audio.playSongCallCount, 0);
    expect(audio.queueAndPlaySongCallCount, 0);

    final mouseGesture = await tester.createGesture(
      kind: PointerDeviceKind.mouse,
    );
    addTearDown(mouseGesture.removePointer);
    await mouseGesture.addPointer();
    await mouseGesture.moveTo(tester.getCenter(find.byType(CoverImage)));
    await tester.pump();

    expect(find.byTooltip('播放当前歌曲'), findsOneWidget);

    await tester.tap(find.byTooltip('播放当前歌曲'));
    await tester.pump();

    expect(audio.playSongCallCount, 0);
    expect(audio.queueAndPlaySongCallCount, 1);
    expect(audio.queuedSong?.isSameSong(song), isTrue);
  });

  testWidgets('SongCard current song cover button toggles play state', (
    tester,
  ) async {
    final song = buildSong(name: 'Current Song', hash: 'current-song-hash');
    final persistence = _FakePersistenceProvider();
    final navigation = _FakeNavigationProvider();
    final selection = _FakeSelectionProvider();
    final audio = _FakeAudioProvider(
      currentSong: song,
      initialVolume: 40,
      isPlaying: true,
    );
    addTearDown(audio.dispose);

    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<AudioProvider>.value(value: audio),
          ChangeNotifierProvider<PersistenceProvider>.value(value: persistence),
          ChangeNotifierProvider<NavigationProvider>.value(value: navigation),
          ChangeNotifierProvider<SelectionProvider>.value(value: selection),
        ],
        child: MaterialApp(
          home: Scaffold(
            body: SongCard(
              song: song,
              playlist: [song],
              showCover: true,
              showMore: false,
            ),
          ),
        ),
      ),
    );
    await tester.pump();

    expect(find.byTooltip('暂停当前歌曲'), findsOneWidget);

    await tester.tap(find.byTooltip('暂停当前歌曲'));
    await tester.pump();

    expect(audio.togglePlayCallCount, 1);
    expect(audio.queueAndPlaySongCallCount, 0);
    expect(audio.playSongCallCount, 0);
  });

  testWidgets('SongCard context menu can add song to play next', (
    tester,
  ) async {
    final song = buildSong(name: 'Play Next Song', hash: 'play-next-song-hash');
    final persistence = _FakePersistenceProvider();
    final navigation = _FakeNavigationProvider();
    final selection = _FakeSelectionProvider();
    final audio = _FakeAudioProvider(
      currentSong: buildSong(
        name: 'Other Song',
        hash: 'play-next-other-song-hash',
      ),
      initialVolume: 40,
    );
    addTearDown(audio.dispose);

    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<AudioProvider>.value(value: audio),
          ChangeNotifierProvider<PersistenceProvider>.value(value: persistence),
          ChangeNotifierProvider<NavigationProvider>.value(value: navigation),
          ChangeNotifierProvider<SelectionProvider>.value(value: selection),
          ChangeNotifierProvider<UserProvider>(create: (_) => UserProvider()),
        ],
        child: MaterialApp(
          home: Scaffold(
            body: SizedBox(
              width: 900,
              child: SongCard(
                song: song,
                playlist: [song],
                showCover: true,
                showMore: true,
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.tap(find.byIcon(CupertinoIcons.ellipsis));
    await tester.pumpAndSettle();

    expect(find.text('添加下一首播放'), findsOneWidget);
    expect(find.text('歌曲详情'), findsNothing);
    expect(find.text('查看评论'), findsNothing);

    await tester.tap(find.text('添加下一首播放'));
    await tester.pumpAndSettle();

    expect(audio.addSongToPlayNextCallCount, 1);
    expect(audio.nextQueuedSong?.isSameSong(song), isTrue);
    expect(audio.queueAndPlaySongCallCount, 0);
    expect(audio.playSongCallCount, 0);
  });

  testWidgets(
    'SongList keeps album visible and shows detail/comment icons for the clicked row',
    (tester) async {
      final selectedSong = buildSong(
        name: 'Selected Song',
        hash: 'selected-song',
        albumName: 'Selected Album',
      );
      final unselectedSong = buildSong(
        name: 'Unselected Song',
        hash: 'unselected-song',
        albumName: 'Unselected Album',
      );
      final persistence = _FakePersistenceProvider();
      final navigation = _FakeNavigationProvider();
      final selection = _FakeSelectionProvider();
      final audio = _FakeAudioProvider(
        currentSong: buildSong(
          name: 'Other Song',
          hash: 'selected-actions-other',
        ),
        initialVolume: 40,
      );
      addTearDown(audio.dispose);

      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider<AudioProvider>.value(value: audio),
            ChangeNotifierProvider<PersistenceProvider>.value(
              value: persistence,
            ),
            ChangeNotifierProvider<NavigationProvider>.value(value: navigation),
            ChangeNotifierProvider<SelectionProvider>.value(value: selection),
          ],
          child: MaterialApp(
            home: Scaffold(
              body: SizedBox(
                width: 900,
                height: 320,
                child: SongList(songs: [selectedSong, unselectedSong]),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byIcon(CupertinoIcons.info_circle), findsNothing);
      expect(find.byIcon(CupertinoIcons.chat_bubble_text), findsNothing);

      await tester.tap(find.text('Selected Song'));
      await tester.pumpAndSettle();

      final selectedCard = find.byType(SongCard).at(0);
      final detailButton = find.descendant(
        of: selectedCard,
        matching: find.byIcon(CupertinoIcons.info_circle),
      );
      final commentButton = find.descendant(
        of: selectedCard,
        matching: find.byIcon(CupertinoIcons.chat_bubble_text),
      );
      final albumText = find.descendant(
        of: selectedCard,
        matching: find.text('Selected Album'),
      );
      final favoriteButton = find.descendant(
        of: selectedCard,
        matching: find.byIcon(CupertinoIcons.heart),
      );

      expect(detailButton, findsOneWidget);
      expect(commentButton, findsOneWidget);
      expect(albumText, findsOneWidget);

      expect(
        tester.getCenter(detailButton).dx,
        lessThan(tester.getCenter(favoriteButton).dx),
      );
      expect(
        tester.getCenter(commentButton).dx,
        lessThan(tester.getCenter(albumText).dx),
      );
      expect(
        tester.getCenter(detailButton).dx,
        lessThan(tester.getCenter(albumText).dx),
      );

      await tester.tap(detailButton);
      await tester.pump();

      expect(navigation.openSongDetailCallCount, 1);
      expect(navigation.lastDetailSong?.isSameSong(selectedSong), isTrue);
      expect(commentButton, findsOneWidget);

      await tester.tap(commentButton);
      await tester.pump();

      expect(navigation.openSongCommentCallCount, 1);
      expect(navigation.lastCommentSong?.isSameSong(selectedSong), isTrue);
    },
  );

  testWidgets(
    'SongCard shows detail/comment icons on hover without hiding album',
    (tester) async {
      final song = buildSong(
        name: 'Hover Action Song',
        hash: 'hover-action-song',
        albumName: 'Hover Album',
      );
      final persistence = _FakePersistenceProvider();
      final navigation = _FakeNavigationProvider();
      final selection = _FakeSelectionProvider();
      final audio = _FakeAudioProvider(
        currentSong: buildSong(name: 'Other Song', hash: 'hover-action-other'),
        initialVolume: 40,
      );
      addTearDown(audio.dispose);

      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider<AudioProvider>.value(value: audio),
            ChangeNotifierProvider<PersistenceProvider>.value(
              value: persistence,
            ),
            ChangeNotifierProvider<NavigationProvider>.value(value: navigation),
            ChangeNotifierProvider<SelectionProvider>.value(value: selection),
          ],
          child: MaterialApp(
            home: Scaffold(
              body: SizedBox(
                width: 720,
                child: SongCard(
                  song: song,
                  playlist: [song],
                  showCover: true,
                  showMore: true,
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byIcon(CupertinoIcons.info_circle), findsNothing);
      expect(find.byIcon(CupertinoIcons.chat_bubble_text), findsNothing);
      expect(find.text('Hover Album'), findsOneWidget);

      final mouseGesture = await tester.createGesture(
        kind: PointerDeviceKind.mouse,
      );
      addTearDown(mouseGesture.removePointer);
      await mouseGesture.addPointer();
      await mouseGesture.moveTo(tester.getCenter(find.byType(SongCard)));
      await tester.pumpAndSettle();

      expect(find.byIcon(CupertinoIcons.info_circle), findsOneWidget);
      expect(find.byIcon(CupertinoIcons.chat_bubble_text), findsOneWidget);
      expect(find.text('Hover Album'), findsOneWidget);
    },
  );

  testWidgets(
    'SongCard does not show detail/comment icons in batch selection mode',
    (tester) async {
      final song = buildSong(name: 'Batch Song', hash: 'batch-song');
      final persistence = _FakePersistenceProvider();
      final navigation = _FakeNavigationProvider();
      final selection = _FakeSelectionProvider(
        selectionMode: true,
        selectedHashes: {song.hash},
      );
      final audio = _FakeAudioProvider(
        currentSong: buildSong(name: 'Other Song', hash: 'batch-song-other'),
        initialVolume: 40,
      );
      addTearDown(audio.dispose);

      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider<AudioProvider>.value(value: audio),
            ChangeNotifierProvider<PersistenceProvider>.value(
              value: persistence,
            ),
            ChangeNotifierProvider<NavigationProvider>.value(value: navigation),
            ChangeNotifierProvider<SelectionProvider>.value(value: selection),
          ],
          child: MaterialApp(
            home: Scaffold(
              body: SizedBox(
                width: 720,
                child: SongCard(
                  song: song,
                  playlist: [song],
                  showCover: true,
                  showMore: true,
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      final mouseGesture = await tester.createGesture(
        kind: PointerDeviceKind.mouse,
      );
      addTearDown(mouseGesture.removePointer);
      await mouseGesture.addPointer();
      await mouseGesture.moveTo(tester.getCenter(find.byType(SongCard)));
      await tester.pumpAndSettle();

      expect(find.byIcon(CupertinoIcons.info_circle), findsNothing);
      expect(find.byIcon(CupertinoIcons.chat_bubble_text), findsNothing);
    },
  );

  testWidgets(
    'SongCard more button keeps click affordance and opens on tap down',
    (tester) async {
      final song = buildSong(
        name: 'Fast Menu Song',
        hash: 'fast-menu-song-hash',
      );
      final persistence = _FakePersistenceProvider();
      final navigation = _FakeNavigationProvider();
      final selection = _FakeSelectionProvider();
      final audio = _FakeAudioProvider(
        currentSong: buildSong(
          name: 'Other Song',
          hash: 'fast-menu-other-song-hash',
        ),
        initialVolume: 40,
      );
      addTearDown(audio.dispose);

      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider<AudioProvider>.value(value: audio),
            ChangeNotifierProvider<PersistenceProvider>.value(
              value: persistence,
            ),
            ChangeNotifierProvider<NavigationProvider>.value(value: navigation),
            ChangeNotifierProvider<SelectionProvider>.value(value: selection),
            ChangeNotifierProvider<UserProvider>(create: (_) => UserProvider()),
          ],
          child: MaterialApp(
            home: Scaffold(
              body: SizedBox(
                width: 900,
                child: SongCard(
                  song: song,
                  playlist: [song],
                  showCover: true,
                  showMore: true,
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      final ellipsisFinder = find.byIcon(CupertinoIcons.ellipsis);
      final mouseRegions = tester.widgetList<MouseRegion>(
        find.ancestor(of: ellipsisFinder, matching: find.byType(MouseRegion)),
      );
      expect(
        mouseRegions.any((region) => region.cursor == SystemMouseCursors.click),
        isTrue,
      );

      final gesture = await tester.createGesture(kind: PointerDeviceKind.mouse);
      addTearDown(gesture.removePointer);
      await gesture.addPointer();
      await gesture.moveTo(tester.getCenter(ellipsisFinder));
      await tester.pump();

      await gesture.down(tester.getCenter(ellipsisFinder));
      await tester.pump();

      expect(find.text('添加下一首播放'), findsOneWidget);

      await gesture.up();
    },
  );

  testWidgets('SongCard shows hover frame when pointer enters card', (
    tester,
  ) async {
    final song = buildSong(name: 'Hover Song', hash: 'hover-song-hash');
    final persistence = _FakePersistenceProvider();
    final navigation = _FakeNavigationProvider();
    final selection = _FakeSelectionProvider();
    final audio = _FakeAudioProvider(
      currentSong: buildSong(name: 'Other Song', hash: 'hover-other-song-hash'),
      initialVolume: 40,
    );
    addTearDown(audio.dispose);

    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<AudioProvider>.value(value: audio),
          ChangeNotifierProvider<PersistenceProvider>.value(value: persistence),
          ChangeNotifierProvider<NavigationProvider>.value(value: navigation),
          ChangeNotifierProvider<SelectionProvider>.value(value: selection),
        ],
        child: MaterialApp(
          home: Scaffold(
            body: SongCard(
              song: song,
              playlist: [song],
              showCover: true,
              showMore: false,
            ),
          ),
        ),
      ),
    );
    await tester.pump();

    final cardContainerFinder = find.descendant(
      of: find.byType(InkWell),
      matching: find.byType(AnimatedContainer),
    );

    expect(
      (tester.widget<AnimatedContainer>(cardContainerFinder).decoration
          as BoxDecoration?),
      isNull,
    );

    final mouseGesture = await tester.createGesture(
      kind: PointerDeviceKind.mouse,
    );
    addTearDown(mouseGesture.removePointer);
    await mouseGesture.addPointer();
    await mouseGesture.moveTo(tester.getCenter(find.byType(SongCard)));
    await tester.pumpAndSettle();

    final hoveredDecoration =
        tester.widget<AnimatedContainer>(cardContainerFinder).decoration
            as BoxDecoration?;
    expect(hoveredDecoration, isNotNull);
    expect(hoveredDecoration?.border, isNotNull);
  });

  testWidgets('SongCard clears hover frame when suppressHover becomes true', (
    tester,
  ) async {
    final song = buildSong(
      name: 'Suppressed Hover Song',
      hash: 'suppressed-hover-song-hash',
    );
    final persistence = _FakePersistenceProvider();
    final navigation = _FakeNavigationProvider();
    final selection = _FakeSelectionProvider();
    final audio = _FakeAudioProvider(
      currentSong: buildSong(
        name: 'Other Song',
        hash: 'suppressed-hover-other-song-hash',
      ),
      initialVolume: 40,
    );
    addTearDown(audio.dispose);

    var suppressHover = false;
    late StateSetter hostSetState;

    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<AudioProvider>.value(value: audio),
          ChangeNotifierProvider<PersistenceProvider>.value(value: persistence),
          ChangeNotifierProvider<NavigationProvider>.value(value: navigation),
          ChangeNotifierProvider<SelectionProvider>.value(value: selection),
        ],
        child: MaterialApp(
          home: StatefulBuilder(
            builder: (context, setState) {
              hostSetState = setState;
              return Scaffold(
                body: SongCard(
                  song: song,
                  playlist: [song],
                  showCover: true,
                  showMore: false,
                  suppressHover: suppressHover,
                ),
              );
            },
          ),
        ),
      ),
    );
    await tester.pump();

    final cardContainerFinder = find.descendant(
      of: find.byType(InkWell),
      matching: find.byType(AnimatedContainer),
    );

    final mouseGesture = await tester.createGesture(
      kind: PointerDeviceKind.mouse,
    );
    addTearDown(mouseGesture.removePointer);
    await mouseGesture.addPointer();
    await mouseGesture.moveTo(tester.getCenter(find.byType(SongCard)));
    await tester.pumpAndSettle();

    expect(
      tester.widget<AnimatedContainer>(cardContainerFinder).decoration,
      isA<BoxDecoration>(),
    );

    hostSetState(() => suppressHover = true);
    await tester.pump();

    expect(
      tester.widget<AnimatedContainer>(cardContainerFinder).decoration,
      isNull,
    );
  });

  testWidgets(
    'SongCard favorite heart keeps placeholder and toggles icon state',
    (tester) async {
      final song = buildSong(name: 'Favorite Song', hash: 'favorite-song-hash');
      final persistence = _FakePersistenceProvider(favoriteHashes: {song.hash});
      final navigation = _FakeNavigationProvider();
      final selection = _FakeSelectionProvider();
      final audio = _FakeAudioProvider(
        currentSong: buildSong(
          name: 'Other Song',
          hash: 'favorite-other-song-hash',
        ),
        initialVolume: 40,
      );
      addTearDown(audio.dispose);

      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider<AudioProvider>.value(value: audio),
            ChangeNotifierProvider<PersistenceProvider>.value(
              value: persistence,
            ),
            ChangeNotifierProvider<NavigationProvider>.value(value: navigation),
            ChangeNotifierProvider<SelectionProvider>.value(value: selection),
          ],
          child: MaterialApp(
            home: Scaffold(
              body: SongCard(
                song: song,
                playlist: [song],
                showCover: true,
                showMore: false,
              ),
            ),
          ),
        ),
      );
      await tester.pump();

      expect(find.byTooltip('取消收藏'), findsOneWidget);
      expect(find.byIcon(CupertinoIcons.heart_fill), findsOneWidget);

      final favoriteMouseRegion = tester.widget<MouseRegion>(
        find
            .ancestor(
              of: find.byIcon(CupertinoIcons.heart_fill),
              matching: find.byType(MouseRegion),
            )
            .first,
      );
      expect(favoriteMouseRegion.cursor, SystemMouseCursors.click);

      final favoriteScaleFinder = find.ancestor(
        of: find.byIcon(CupertinoIcons.heart_fill),
        matching: find.byType(AnimatedScale),
      );
      expect(
        tester.widget<AnimatedScale>(favoriteScaleFinder).scale,
        equals(1.0),
      );

      final mouseGesture = await tester.createGesture(
        kind: PointerDeviceKind.mouse,
      );
      addTearDown(mouseGesture.removePointer);
      await mouseGesture.addPointer();
      await mouseGesture.moveTo(
        tester.getCenter(find.byIcon(CupertinoIcons.heart_fill)),
      );
      await tester.pumpAndSettle();

      expect(
        tester.widget<AnimatedScale>(favoriteScaleFinder).scale,
        closeTo(1.15, 0.001),
      );

      await tester.tap(find.byTooltip('取消收藏'));
      await tester.pump();

      expect(persistence.toggleFavoriteCallCount, 1);
      expect(find.byTooltip('取消收藏'), findsNothing);
      expect(find.byTooltip('收藏'), findsOneWidget);
      expect(find.byIcon(CupertinoIcons.heart_fill), findsNothing);
      expect(find.byIcon(CupertinoIcons.heart), findsOneWidget);
    },
  );

  testWidgets('SongCard favorite heart stays in a fixed slot for long titles', (
    tester,
  ) async {
    final shortSong = buildSong(name: '短歌名', hash: 'fixed-favorite-short');
    final longSong = buildSong(
      name: '这是一个很长很长很长很长的歌曲标题用于验证收藏按钮位置',
      hash: 'fixed-favorite-long',
    );
    final persistence = _FakePersistenceProvider(
      favoriteHashes: {shortSong.hash, longSong.hash},
    );
    final navigation = _FakeNavigationProvider();
    final selection = _FakeSelectionProvider();
    final audio = _FakeAudioProvider(
      currentSong: buildSong(name: 'Other Song', hash: 'fixed-favorite-other'),
      initialVolume: 40,
    );
    addTearDown(audio.dispose);

    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<AudioProvider>.value(value: audio),
          ChangeNotifierProvider<PersistenceProvider>.value(value: persistence),
          ChangeNotifierProvider<NavigationProvider>.value(value: navigation),
          ChangeNotifierProvider<SelectionProvider>.value(value: selection),
        ],
        child: MaterialApp(
          home: Scaffold(
            body: Column(
              children: [
                SizedBox(
                  width: 900,
                  child: SongCard(
                    song: shortSong,
                    playlist: [shortSong],
                    showCover: true,
                    showMore: true,
                  ),
                ),
                SizedBox(
                  width: 900,
                  child: SongCard(
                    song: longSong,
                    playlist: [longSong],
                    showCover: true,
                    showMore: true,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();

    final cards = find.byType(SongCard);
    final shortFavorite = find.descendant(
      of: cards.at(0),
      matching: find.byIcon(CupertinoIcons.heart_fill),
    );
    final longFavorite = find.descendant(
      of: cards.at(1),
      matching: find.byIcon(CupertinoIcons.heart_fill),
    );

    expect(
      tester.getCenter(shortFavorite).dx,
      closeTo(tester.getCenter(longFavorite).dx, 0.1),
    );
  });

  testWidgets(
    'SongCard double tap on cover triggers playlist replacement callback',
    (tester) async {
      final song = buildSong(
        name: 'Cover Double Tap Song',
        hash: 'cover-double-tap-hash',
      );
      final persistence = _FakePersistenceProvider();
      final navigation = _FakeNavigationProvider();
      final selection = _FakeSelectionProvider();
      final audio = _FakeAudioProvider(
        currentSong: buildSong(
          name: 'Other Song',
          hash: 'cover-double-tap-other-hash',
        ),
        initialVolume: 40,
      );
      Song? tappedSong;
      addTearDown(audio.dispose);

      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider<AudioProvider>.value(value: audio),
            ChangeNotifierProvider<PersistenceProvider>.value(
              value: persistence,
            ),
            ChangeNotifierProvider<NavigationProvider>.value(value: navigation),
            ChangeNotifierProvider<SelectionProvider>.value(value: selection),
          ],
          child: MaterialApp(
            home: Scaffold(
              body: SongCard(
                song: song,
                playlist: [song],
                showCover: true,
                showMore: false,
                onDoubleTapPlay: (selectedSong) async {
                  tappedSong = selectedSong;
                },
              ),
            ),
          ),
        ),
      );
      await tester.pump();

      final mouseGesture = await tester.createGesture(
        kind: PointerDeviceKind.mouse,
      );
      addTearDown(mouseGesture.removePointer);
      await mouseGesture.addPointer();
      await mouseGesture.moveTo(tester.getCenter(find.byType(CoverImage)));
      await tester.pump();

      final coverCenter = tester.getCenter(find.byType(CoverImage));
      await tester.tapAt(coverCenter);
      await tester.pump(const Duration(milliseconds: 50));
      await tester.tapAt(coverCenter);
      await tester.pump(const Duration(milliseconds: 100));

      expect(tappedSong?.isSameSong(song), isTrue);
      expect(audio.playSongCallCount, 0);
      expect(audio.queueAndPlaySongCallCount, 0);
    },
  );

  testWidgets(
    'SongCard double tap queues current song when default double tap play is enabled',
    (tester) async {
      final song = buildSong(
        name: 'Double Tap Queue Song',
        hash: 'double-tap-queue-hash',
      );
      final persistence = _FakePersistenceProvider();
      final navigation = _FakeNavigationProvider();
      final selection = _FakeSelectionProvider();
      final audio = _FakeAudioProvider(
        currentSong: buildSong(
          name: 'Other Song',
          hash: 'double-tap-other-song-hash',
        ),
        initialVolume: 40,
      );
      addTearDown(audio.dispose);

      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider<AudioProvider>.value(value: audio),
            ChangeNotifierProvider<PersistenceProvider>.value(
              value: persistence,
            ),
            ChangeNotifierProvider<NavigationProvider>.value(value: navigation),
            ChangeNotifierProvider<SelectionProvider>.value(value: selection),
          ],
          child: MaterialApp(
            home: Scaffold(
              body: SongCard(
                song: song,
                playlist: [song],
                showCover: false,
                showMore: false,
                enableDefaultDoubleTapPlay: true,
              ),
            ),
          ),
        ),
      );
      await tester.pump();

      final rowInkWell = tester
          .widgetList<InkWell>(
            find.descendant(
              of: find.byType(SongCard),
              matching: find.byType(InkWell),
            ),
          )
          .singleWhere(
            (inkWell) => inkWell.onTap == null && inkWell.onDoubleTap != null,
          );

      rowInkWell.onDoubleTap!();
      await tester.pump();

      expect(audio.queueAndPlaySongCallCount, 1);
      expect(audio.queuedSong?.isSameSong(song), isTrue);
      expect(audio.playSongCallCount, 0);
    },
  );

  testWidgets(
    'SongCard cover double tap queues current song when default double tap play is enabled',
    (tester) async {
      final song = buildSong(
        name: 'Cover Double Tap Queue Song',
        hash: 'cover-double-tap-queue-hash',
      );
      final persistence = _FakePersistenceProvider();
      final navigation = _FakeNavigationProvider();
      final selection = _FakeSelectionProvider();
      final audio = _FakeAudioProvider(
        currentSong: buildSong(
          name: 'Other Song',
          hash: 'cover-double-tap-queue-other-hash',
        ),
        initialVolume: 40,
      );
      addTearDown(audio.dispose);

      await tester.pumpWidget(
        MultiProvider(
          providers: [
            ChangeNotifierProvider<AudioProvider>.value(value: audio),
            ChangeNotifierProvider<PersistenceProvider>.value(
              value: persistence,
            ),
            ChangeNotifierProvider<NavigationProvider>.value(value: navigation),
            ChangeNotifierProvider<SelectionProvider>.value(value: selection),
          ],
          child: MaterialApp(
            home: Scaffold(
              body: SongCard(
                song: song,
                playlist: [song],
                showCover: true,
                showMore: false,
                enableDefaultDoubleTapPlay: true,
              ),
            ),
          ),
        ),
      );
      await tester.pump();

      final mouseGesture = await tester.createGesture(
        kind: PointerDeviceKind.mouse,
      );
      addTearDown(mouseGesture.removePointer);
      await mouseGesture.addPointer();
      await mouseGesture.moveTo(tester.getCenter(find.byType(CoverImage)));
      await tester.pump();

      final coverCenter = tester.getCenter(find.byType(CoverImage));
      await tester.tapAt(coverCenter);
      await tester.pump(const Duration(milliseconds: 50));
      await tester.tapAt(coverCenter);
      await tester.pump(const Duration(milliseconds: 100));

      expect(audio.queueAndPlaySongCallCount, 1);
      expect(audio.queuedSong?.isSameSong(song), isTrue);
      expect(audio.playSongCallCount, 0);
    },
  );

  testWidgets('SongCard double tap triggers playlist replacement callback', (
    tester,
  ) async {
    final song = buildSong(name: 'Double Tap Song', hash: 'double-tap-hash');
    final persistence = _FakePersistenceProvider();
    final navigation = _FakeNavigationProvider();
    final selection = _FakeSelectionProvider();
    final audio = _FakeAudioProvider(
      currentSong: buildSong(name: 'Other Song', hash: 'other-song-hash-2'),
      initialVolume: 40,
    );
    Song? tappedSong;
    addTearDown(audio.dispose);

    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<AudioProvider>.value(value: audio),
          ChangeNotifierProvider<PersistenceProvider>.value(value: persistence),
          ChangeNotifierProvider<NavigationProvider>.value(value: navigation),
          ChangeNotifierProvider<SelectionProvider>.value(value: selection),
        ],
        child: MaterialApp(
          home: Scaffold(
            body: SongCard(
              song: song,
              playlist: [song],
              showCover: false,
              showMore: false,
              onDoubleTapPlay: (selectedSong) async {
                tappedSong = selectedSong;
              },
            ),
          ),
        ),
      ),
    );
    await tester.pump();

    final rowInkWell = tester
        .widgetList<InkWell>(
          find.descendant(
            of: find.byType(SongCard),
            matching: find.byType(InkWell),
          ),
        )
        .singleWhere((inkWell) => inkWell.onDoubleTap != null);

    expect(rowInkWell.onDoubleTap, isNotNull);
    rowInkWell.onDoubleTap!.call();
    await tester.pump();

    expect(tappedSong?.isSameSong(song), isTrue);
    expect(audio.playSongCallCount, 0);
  });
}
