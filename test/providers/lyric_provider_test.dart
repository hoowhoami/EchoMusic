import 'package:echomusic/providers/lyric_provider.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('LyricProvider clears old lyrics while loading a new song', () {
    final provider = LyricProvider();

    provider.parseLyrics({'lyric': '[00:01.00]旧歌词'}, hash: 'old-song');

    expect(provider.lyrics, isNotEmpty);
    expect(provider.loadedHash, 'old-song');

    provider.beginLoading(hash: 'new-song');

    expect(provider.lyrics, isEmpty);
    expect(provider.currentLineIndex, -1);
    expect(provider.loadedHash, 'new-song');
    expect(provider.tips, '歌词加载中...');
  });

  test(
    'LyricProvider clear keeps new song hash when lyric request returns empty',
    () {
      final provider = LyricProvider();

      provider.parseLyrics({'lyric': '[00:01.00]旧歌词'}, hash: 'old-song');

      provider.clear(hash: 'new-song');

      expect(provider.lyrics, isEmpty);
      expect(provider.currentLineIndex, -1);
      expect(provider.loadedHash, 'new-song');
      expect(provider.tips, '暂无歌词');
    },
  );
}
