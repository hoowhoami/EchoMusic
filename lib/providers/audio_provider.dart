import 'package:flutter/material.dart';
import 'package:just_audio/just_audio.dart';
import '../models/song.dart';
import '../api/music_api.dart';
import 'lyric_provider.dart';
import 'persistence_provider.dart';

class AudioProvider with ChangeNotifier {
  final AudioPlayer _player = AudioPlayer();
  Song? _currentSong;
  List<Song> _playlist = [];
  List<Song> _originalPlaylist = [];
  int _currentIndex = -1;
  LyricProvider? _lyricProvider;
  PersistenceProvider? _persistenceProvider;

  LoopMode _loopMode = LoopMode.off;
  bool _isShuffle = false;

  AudioPlayer get player => _player;
  Song? get currentSong => _currentSong;
  List<Song> get playlist => _playlist;
  bool get isPlaying => _player.playing;
  LoopMode get loopMode => _loopMode;
  bool get isShuffle => _isShuffle;

  AudioProvider() {
    _player.playerStateStream.listen((state) {
      if (state.processingState == ProcessingState.completed) {
        if (_loopMode == LoopMode.one) {
          _player.seek(Duration.zero);
          _player.play();
        } else {
          next();
        }
      }
      notifyListeners();
    });

    _player.positionStream.listen((position) {
      _lyricProvider?.updateHighlight(position);
    });

    _player.volumeStream.listen((volume) {
      _persistenceProvider?.saveVolume(volume);
    });
  }

  void setLyricProvider(LyricProvider provider) {
    _lyricProvider = provider;
  }

  void setPersistenceProvider(PersistenceProvider provider) {
    _persistenceProvider = provider;
    _player.setVolume(provider.volume);
  }

  void toggleLoopMode() {
    if (_loopMode == LoopMode.off) {
      _loopMode = LoopMode.all;
    } else if (_loopMode == LoopMode.all) {
      _loopMode = LoopMode.one;
    } else {
      _loopMode = LoopMode.off;
    }
    notifyListeners();
  }

  void toggleShuffle() {
    _isShuffle = !_isShuffle;
    if (_isShuffle) {
      _originalPlaylist = List.from(_playlist);
      _playlist.shuffle();
    } else {
      _playlist = List.from(_originalPlaylist);
    }
    _currentIndex = _playlist.indexWhere((s) => s.hash == _currentSong?.hash);
    notifyListeners();
  }

  Future<void> playSong(Song song, {List<Song>? playlist}) async {
    if (playlist != null) {
      _playlist = List.from(playlist);
      _originalPlaylist = List.from(playlist);
      if (_isShuffle) {
        _playlist.shuffle();
      }
      _currentIndex = _playlist.indexWhere((s) => s.hash == song.hash);
    }
    
    _currentSong = song;
    notifyListeners();

    _persistenceProvider?.addToHistory(song);
    _lyricProvider?.clear();
    _fetchLyrics(song.hash);

    final url = await MusicApi.getSongUrl(song.hash);
    if (url != null) {
      try {
        await _player.setUrl(url);
        _player.play();
      } catch (e) {
        print('Error playing song: $e');
      }
    }
  }

  Future<void> _fetchLyrics(String hash) async {
    final searchResult = await MusicApi.searchLyric(hash);
    if (searchResult != null && searchResult['info'] != null && searchResult['info'].isNotEmpty) {
      final firstLyric = searchResult['info'][0];
      final lrc = await MusicApi.getLyric(firstLyric['id'], firstLyric['accesskey']);
      if (lrc != null) {
        _lyricProvider?.parseLyrics(lrc);
      }
    }
  }

  void togglePlay() {
    if (_player.playing) {
      _player.pause();
    } else {
      _player.play();
    }
    notifyListeners();
  }

  void next() {
    if (_playlist.isEmpty) return;
    _currentIndex = (_currentIndex + 1) % _playlist.length;
    playSong(_playlist[_currentIndex]);
  }

  void previous() {
    if (_playlist.isEmpty) return;
    _currentIndex = (_currentIndex - 1 + _playlist.length) % _playlist.length;
    playSong(_playlist[_currentIndex]);
  }

  @override
  void dispose() {
    _player.dispose();
    super.dispose();
  }
}