import 'dart:async';

import 'package:echomusic/models/song.dart';
import 'package:echomusic/providers/audio_provider.dart';
import 'package:echomusic/providers/user_provider.dart';
import 'package:echomusic/ui/widgets/song_batch_selection_dialog.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

class _FakeAudioProvider extends ChangeNotifier implements AudioProvider {
  int playSongCallCount = 0;
  Song? lastPlayedSong;
  List<Song>? lastPlayedPlaylist;

  @override
  Future<void> playSong(Song song, {List<Song>? playlist}) async {
    playSongCallCount++;
    lastPlayedSong = song;
    lastPlayedPlaylist = playlist;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => super.noSuchMethod(invocation);
}

void main() {
  testWidgets('batch action button opens selection dialog and plays checked songs', (tester) async {
    final audioProvider = _FakeAudioProvider();
    final song = Song(
      hash: 'hash-1',
      name: '测试歌曲',
      albumName: '测试专辑',
      singers: [SingerInfo(id: 1, name: '测试歌手')],
      duration: 245,
      cover: '',
      mixSongId: 1,
    );

    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<AudioProvider>.value(value: audioProvider),
          ChangeNotifierProvider(create: (_) => UserProvider()),
        ],
        child: MaterialApp(
          home: Scaffold(
            body: Align(
              alignment: Alignment.topLeft,
              child: SongBatchActionButton(songs: [song]),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('批量'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('播放'), findsOneWidget);
    expect(find.text('添加到'), findsOneWidget);
    expect(find.text('删除'), findsOneWidget);
    expect(find.text('完成'), findsOneWidget);
    expect(find.text('测试歌曲'), findsOneWidget);

    await tester.tap(find.text('测试歌曲'));
    await tester.pump();

    expect(find.text('共 1 首 / 已选 1 首'), findsOneWidget);

    await tester.tap(find.text('播放'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(audioProvider.playSongCallCount, 1);
    expect(audioProvider.lastPlayedSong?.name, '测试歌曲');
    expect(audioProvider.lastPlayedPlaylist?.length, 1);
    expect(find.text('完成'), findsNothing);
  });

  testWidgets('batch action button stays tappable while background resolve is running', (tester) async {
    final song = Song(
      hash: 'hash-2',
      name: '准备中的歌曲',
      albumName: '测试专辑',
      singers: [SingerInfo(id: 2, name: '测试歌手')],
      duration: 180,
      cover: '',
      mixSongId: 2,
    );
    final completer = Completer<List<Song>>();
    var resolveCount = 0;

    await tester.pumpWidget(
      MultiProvider(
        providers: [
          ChangeNotifierProvider<AudioProvider>.value(value: _FakeAudioProvider()),
          ChangeNotifierProvider(create: (_) => UserProvider()),
        ],
        child: MaterialApp(
          home: Scaffold(
            body: Align(
              alignment: Alignment.topLeft,
              child: SongBatchActionButton(
                songs: [song],
                isLoadingHint: true,
                onResolveSongs: () {
                  resolveCount++;
                  return completer.future;
                },
              ),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('批量'));
    await tester.pump();
    expect(resolveCount, 1);

    completer.complete([song]);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.text('准备中的歌曲'), findsOneWidget);
  });
}