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
  double _playbackRate = 1.0;
  Map<double, String> _climaxMarks = {};

  AudioPlayer get player => _player;
  Song? get currentSong => _currentSong;
  List<Song> get playlist => _playlist;
  int get currentIndex => _currentIndex;
  bool get isPlaying => _player.playing;
  LoopMode get loopMode => _loopMode;
  bool get isShuffle => _isShuffle;
  double get playbackRate => _playbackRate;
  Map<double, String> get climaxMarks => _climaxMarks;

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

  String _convertQualityToApiValue(String quality) {
    switch (quality) {
      case '标准':
        return '128';
      case '高品质':
        return '320';
      case '无损':
        return 'flac';
      default:
        return 'flac';
    }
  }

  void setPlaybackRate(double rate) {
    _playbackRate = rate;
    _player.setSpeed(rate);
    notifyListeners();
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
    _fetchClimax(song);

    // Get quality setting
    final qualitySetting = _persistenceProvider?.settings['audioQuality'] ?? '无损';
    final quality = _convertQualityToApiValue(qualitySetting);

    final url = await MusicApi.getSongUrl(song.hash, quality: quality);
    if (url != null) {
      try {
        await _player.setUrl(url);
        _player.setSpeed(_playbackRate);
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

  Future<void> _fetchClimax(Song song) async {
    _climaxMarks.clear();
    notifyListeners();

    try {
      final result = await MusicApi.getSongClimaxRaw(song.hash);
      if (result.isNotEmpty) {
        final songDuration = song.duration;
        for (final item in result) {
          final startTime = item['start_time'] ?? item['starttime'];
          final endTime = item['end_time'] ?? item['endtime'];

          if (startTime != null) {
            final start = startTime is String ? int.parse(startTime) : startTime as int;
            if (start > 0) {
              final startProgress = (start / 1000) / songDuration;
              _climaxMarks[startProgress] = '';
            }
          }

          if (endTime != null) {
            final end = endTime is String ? int.parse(endTime) : endTime as int;
            if (end > 0) {
              final endProgress = (end / 1000) / songDuration;
              _climaxMarks[endProgress] = '';
            }
          }
        }
        notifyListeners();
      }
    } catch (e) {
      // Silently fail if climax fetching fails
      debugPrint('Error fetching climax: $e');
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

  void clearPlaylist() {
    _playlist = [];
    _originalPlaylist = [];
    _currentIndex = -1;
    notifyListeners();
  }

  void removeFromPlaylist(int index) {
    if (index < 0 || index >= _playlist.length) return;

    final removed = _playlist[index];
    _playlist.removeAt(index);

    if (_currentIndex == index) {
      if (_playlist.isEmpty) {
        _currentSong = null;
        _player.stop();
      } else if (index < _playlist.length) {
        _currentIndex = index;
        playSong(_playlist[_currentIndex]);
      } else {
        _currentIndex = _playlist.length - 1;
        playSong(_playlist[_currentIndex]);
      }
    } else if (_currentIndex > index) {
      _currentIndex--;
    }

    if (_isShuffle) {
      _originalPlaylist.removeWhere((s) => s.hash == removed.hash);
    }

    notifyListeners();
  }

  @override
  void dispose() {
    _player.dispose();
    super.dispose();
  }
}