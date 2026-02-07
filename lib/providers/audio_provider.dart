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
  bool _isLoading = false;
  final Map<double, String> _climaxMarks = {};

  AudioPlayer get player => _player;
  Song? get currentSong => _currentSong;
  List<Song> get playlist => _playlist;
  int get currentIndex => _currentIndex;
  bool get isPlaying => _player.playing;
  bool get isLoading => _isLoading;
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
    }
    
    _currentIndex = _playlist.indexWhere((s) => s.hash == song.hash);
    _currentSong = song;
    notifyListeners();

    await _initPlayer(song);
  }

  Future<void> _initPlayer(Song song) async {
    _isLoading = true;
    notifyListeners();

    try {
      _persistenceProvider?.addToHistory(song);
      _lyricProvider?.clear();
      _fetchLyrics(song.hash);
      _fetchClimax(song);

      final urlResult = await _getAudioUrlWithQuality(song);
      if (urlResult != null) {
        final String url = urlResult['url'];
        final isFlac = urlResult['isFlac'];
        
        debugPrint('Playing URL: $url (Lossless: $isFlac)');

        final source = AudioSource.uri(
          Uri.parse(url),
          headers: {
            'User-Agent': 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi',
          },
        );

        await _player.setAudioSource(source);
        _player.setSpeed(_playbackRate);
        _player.play();
      } else {
        _handleLoadFailure(song);
      }
    } catch (e) {
      debugPrint('Error initializing player: $e');
      // Graceful fallback for macOS/iOS specific AVPlayer errors (-11800, etc)
      if (e.toString().contains('-11800') || e.toString().contains('codec')) {
        debugPrint('Detected format/loading error, trying fallback standard quality...');
        final result = await MusicApi.getSongUrl(song.hash, quality: '128');
        if (result != null && result['status'] == 1 && result['url'] != null) {
          try {
            await _player.setUrl(result['url']);
            _player.play();
            return;
          } catch (fallbackError) {
            debugPrint('Fallback also failed: $fallbackError');
          }
        }
      }
      _handleLoadFailure(song);
    } finally {
      _isLoading = false;
      notifyListeners();
    }
  }

  void _handleLoadFailure(Song song) {
    debugPrint('Failed to get playable URL for ${song.title}');
    if (_persistenceProvider?.settings['autoNext'] ?? true) {
      next();
    }
  }

  Future<Map<String, dynamic>?> _getAudioUrlWithQuality(Song song) async {
    if (song.source == 'cloud') {
      final url = await MusicApi.getCloudSongUrl(song.hash);
      return url != null ? {'url': url, 'isFlac': false} : null;
    }

    // 动态获取歌曲权限和关联音质信息 (relate_goods)
    final privilegeList = await MusicApi.getSongPrivilege(song.hash, albumId: song.albumId);
    final List<dynamic> relateGoods = privilegeList.isNotEmpty 
        ? (privilegeList[0]['relate_goods'] ?? []) 
        : (song.relateGoods ?? []);

    final settings = _persistenceProvider?.settings ?? {};
    final primaryQuality = settings['audioQuality'] ?? 'flac';
    final backupQuality = settings['backupQuality'] ?? '128';
    final compatibilityMode = settings['compatibilityMode'] ?? true;

    final qualitiesToTry = [primaryQuality];
    if (compatibilityMode && backupQuality != primaryQuality) {
      qualitiesToTry.add(backupQuality);
    }

    for (var apiQuality in qualitiesToTry) {
      String targetHash = song.hash;

      // 在最新的 relateGoods 中寻找匹配音质的 hash
      if (relateGoods.isNotEmpty) {
        Map<String, dynamic>? match;
        for (final item in relateGoods) {
          if (item['quality'] == apiQuality) {
            match = item is Map<String, dynamic> ? item : Map<String, dynamic>.from(item);
            break;
          }
        }
        if (match != null && match['hash'] != null) {
          targetHash = match['hash'];
        }
      }

      final result = await MusicApi.getSongUrl(targetHash, quality: apiQuality);
      if (result != null) {
        final status = result['status'];
        final url = result['url'];
        
        if (status == 1 && url != null && url.isNotEmpty) {
          return {
            'url': url,
            'isFlac': apiQuality == 'flac',
          };
        } else if (status == 2) {
          debugPrint('Quality $apiQuality requires VIP, trying next...');
        } else if (status == 3) {
          debugPrint('Quality $apiQuality has no copyright, trying next...');
        }
      }
    }

    if (compatibilityMode) {
      final result = await MusicApi.getSongUrl(song.hash);
      if (result != null && result['status'] == 1 && result['url'] != null) {
        return {'url': result['url'], 'isFlac': false};
      }
    }

    return null;
  }

  Future<void> _fetchLyrics(String hash) async {
    final searchResult = await MusicApi.searchLyric(hash);
    
    dynamic targetCandidate;
    if (searchResult != null && searchResult['candidates'] != null && searchResult['candidates'] is List && searchResult['candidates'].isNotEmpty) {
      targetCandidate = searchResult['candidates'][0];
    } else if (searchResult != null && searchResult['info'] != null && searchResult['info'] is List && searchResult['info'].isNotEmpty) {
      targetCandidate = searchResult['info'][0];
    }

    if (targetCandidate != null) {
      final lyricData = await MusicApi.getLyric(
        targetCandidate['id']?.toString() ?? '', 
        targetCandidate['accesskey']?.toString() ?? ''
      );
      if (lyricData != null) {
        _lyricProvider?.parseLyrics(lyricData);
      }
    }
  }

  Future<void> _fetchClimax(Song song) async {
    _climaxMarks.clear();
    notifyListeners();

    try {
      final result = await MusicApi.getSongClimaxRaw(song.hash);
      if (result.isNotEmpty) {
        final songDuration = song.duration > 0 ? song.duration : 1; // Avoid division by zero
        for (final item in result) {
          final startTime = item['start_time'] ?? item['starttime'];
          final endTime = item['end_time'] ?? item['endtime'];

          if (startTime != null) {
            final startMs = startTime is String ? int.parse(startTime) : (startTime as num).toInt();
            if (startMs > 0) {
              final startProgress = (startMs / 1000) / songDuration;
              _climaxMarks[startProgress.clamp(0.0, 1.0)] = '';
            }
          }

          if (endTime != null) {
            final endMs = endTime is String ? int.parse(endTime) : (endTime as num).toInt();
            if (endMs > 0) {
              final endProgress = (endMs / 1000) / songDuration;
              _climaxMarks[endProgress.clamp(0.0, 1.0)] = '';
            }
          }
        }
        notifyListeners();
      }
    } catch (e) {
      debugPrint('Error fetching climax: $e');
    }
  }

  void togglePlay() {
    if (_player.playing) {
      _player.pause();
    } else {
      if (_currentSong != null) {
        _player.play();
      }
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
      } else {
        _currentIndex = _currentIndex % _playlist.length;
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
