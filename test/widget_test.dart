import 'dart:async';

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
import 'package:echomusic/ui/widgets/player_bar.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:echomusic/providers/selection_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _FakeAudioProvider extends ChangeNotifier implements AudioProvider {
  _FakeAudioProvider({required Song currentSong, required double initialVolume})
    : _currentSong = currentSong,
      _displayVolume = initialVolume,
      _lastAudibleVolume = initialVolume > 0 ? initialVolume : 50.0;

  final StreamController<double> _userVolumeController =
      StreamController<double>.broadcast();
  final StreamController<PositionSnapshot> _positionController =
      StreamController<PositionSnapshot>.broadcast();
  final Song _currentSong;
  double _displayVolume;
  double _lastAudibleVolume;

  @override
  Song? get currentSong => _currentSong;

  @override
  bool get isPlaying => false;

  @override
  bool get isLoading => false;

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
  List<Song> get playlist => const [];

  @override
  void previous() {}

  @override
  void next() {}

  @override
  void togglePlay() {}

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

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  Song buildSong({
    required String name,
    String hash = '',
    int mixSongId = 0,
    int? fileId,
    String albumName = 'Album',
    String? albumId,
    String? source,
  }) {
    return Song(
      hash: hash,
      name: name,
      albumName: albumName,
      albumId: albumId,
      singers: [SingerInfo(id: 1, name: 'Singer')],
      duration: 180,
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
}
