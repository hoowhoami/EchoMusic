import 'package:echomusic/api/music_api.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:echomusic/models/song.dart';
import 'package:echomusic/providers/selection_provider.dart';

void main() {
  Song buildSong({
    required String name,
    String hash = '',
    int mixSongId = 0,
    int? fileId,
  }) {
    return Song(
      hash: hash,
      name: name,
      albumName: 'Album',
      singers: [SingerInfo(id: 1, name: 'Singer')],
      duration: 180,
      cover: '',
      mixSongId: mixSongId,
      fileId: fileId,
    );
  }

  test('Song exposes playability based on hash', () {
    final playableSong = buildSong(name: 'Playable', hash: 'ABC123');
    final unavailableSong = buildSong(name: 'Unavailable');

    expect(playableSong.isPlayable, isTrue);
    expect(unavailableSong.isPlayable, isFalse);
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

  test('Song.fromPlaylistJson falls back to filename and trans_param cover', () {
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
  });

  test('Song.fromPlaylistJson falls back to audio_info and album_info metadata', () {
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
  });

  test('MusicApi filters meaningless hashless shell items and reports count', () {
    final result = MusicApi.parsePlaylistSongsFromResponse({
      'data': {
        'songs': [
          {
            'hash': 'abc123',
            'songname': '正常歌曲',
            'author_name': '歌手A',
            'timelen': 180000,
          },
          {
            'shield': 1,
            'fileid': 383,
          },
        ],
      },
    });

    expect(result.filteredCount, 1);
    expect(result.sourceCount, 2);
    expect(result.songs, hasLength(1));
    expect(result.songs.first.name, '正常歌曲');
  });
}
