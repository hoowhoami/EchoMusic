import 'dart:async';
import 'package:flutter/material.dart';
import 'package:just_audio/just_audio.dart';
import 'package:just_audio_background/just_audio_background.dart';
import 'package:wakelock_plus/wakelock_plus.dart';
import '../models/song.dart';
import '../api/music_api.dart';
import '../utils/constants.dart' as app_const;
import '../utils/logger.dart';
import 'lyric_provider.dart';
import 'persistence_provider.dart';

class AudioProvider with ChangeNotifier {
  late AudioPlayer _player;

  // Getter for external use
  AudioPlayer get player => _player;

  // New: Throttled stream for UI progress bars to reduce CPU usage
  Stream<Duration> get throttledPositionStream => _player.positionStream.distinct((prev, curr) {
    final diff = (curr.inMilliseconds - prev.inMilliseconds).abs();
    return diff < 200 && curr.inMilliseconds > prev.inMilliseconds;
  });

  final List<StreamSubscription> _subscriptions = [];
  final StreamController<double> _userVolumeController = StreamController<double>.broadcast();

  Song? _currentSong;
  List<Song> _playlist = [];
  List<Song> _originalPlaylist = [];
  int _currentIndex = -1;
  bool _isLoading = false;
  bool _isDisposed = false;
  double _playbackRate = 1.0;
  double _lastVolume = 0.5;
  Map<double, double> _climaxMarks = {};

  String _playMode = 'repeat'; // 'repeat', 'repeat-once', 'shuffle'

  LyricProvider? _lyricProvider;
  PersistenceProvider? _persistenceProvider;

  Timer? _fadeTimer;
  Timer? _volumeSaveTimer;
  bool _isInternalChanging = false;

  // Getters
  Song? get currentSong => _currentSong;
  List<Song> get playlist => _playlist;
  int get currentIndex => _currentIndex;
  bool get isPlaying => _player.playing;
  bool get isLoading => _isLoading || _player.processingState == ProcessingState.buffering || _player.processingState == ProcessingState.loading;
  String get playMode => _playMode;
  String get loopMode => _playMode; 
  double get playbackRate => _playbackRate;
  Map<double, double> get climaxMarks => _climaxMarks;
  Stream<double> get userVolumeStream => _userVolumeController.stream;

  Duration get effectivePosition {
    return _player.position;
  }

  // FIX: Provide a more reliable duration based on both player metadata and song model
  Duration get effectiveDuration {
    final playerDur = _player.duration;
    if (playerDur != null && playerDur > Duration.zero) return playerDur;
    if (_currentSong != null && _currentSong!.duration > 0) {
      return Duration(seconds: _currentSong!.duration.toInt());
    }
    return Duration.zero;
  }

  AudioProvider() {
    _player = AudioPlayer();
    _initListeners();
  }

  void _fadeVolume(double target, {double? from, int? durationMs, VoidCallback? onComplete}) {
    _fadeTimer?.cancel();
    final bool isFadeEnabled = _persistenceProvider?.settings['volumeFade'] ?? true;
    
    if (!isFadeEnabled) {
      _player.setVolume(target);
      onComplete?.call();
      return;
    }

    final double startVolume = from ?? _player.volume;
    final int duration = durationMs ?? _persistenceProvider?.settings['volumeFadeTime'] ?? 1000;
    
    if (duration <= 0 || (target - startVolume).abs() < 0.01) {
      _player.setVolume(target);
      onComplete?.call();
      return;
    }

    _isInternalChanging = true;
    final int stepMs = 20; 
    final int totalSteps = (duration / stepMs).round();
    final double volumeStep = (target - startVolume) / totalSteps;
    int currentStep = 0;

    LoggerService.d('[AudioProvider] Fade started: $startVolume -> $target (${duration}ms)');

    _fadeTimer = Timer.periodic(Duration(milliseconds: stepMs), (timer) {
      if (_isDisposed) {
        timer.cancel();
        return;
      }

      currentStep++;
      final double newVolume = (startVolume + volumeStep * currentStep).clamp(0.0, 1.0);
      _player.setVolume(newVolume);
      
      if (currentStep >= totalSteps) {
        timer.cancel();
        _fadeTimer = null;
        _player.setVolume(target);
        
        // Windows/mpv settlement delay: wait for events to stop firing before allowing listener to save volume
        Future.delayed(const Duration(milliseconds: 100), () {
          if (!_isDisposed) {
            _isInternalChanging = false;
            LoggerService.d('[AudioProvider] Fade settled and internal flag released.');
          }
        });

        onComplete?.call();
      }
    });
  }

  int _lastSavedSecond = -1;

  void _initListeners() {
    _subscriptions.add(_player.playbackEventStream.listen((event) {
    }, onError: (Object e, StackTrace st) {
      _handlePlayError(e);
    }));

    _subscriptions.add(_player.playerStateStream.listen((state) {
      if (state.processingState == ProcessingState.completed) {
        LoggerService.i('[AudioProvider] Playback completed naturally.');
        _handlePlaybackEnded();
      }
      _safeNotify();
    }));

    _subscriptions.add(_player.positionStream.listen((pos) {
      if (_isDisposed) return;
      final sec = pos.inSeconds;
      
      try {
        final total = _player.duration;
        if (total != null && total > Duration.zero && !_isInternalChanging && _player.playing) {
          final diff = total.inMilliseconds - pos.inMilliseconds;
          if (diff <= 100) {
             LoggerService.i('[AudioProvider] Proactively triggering completion (pos: ${pos.inMilliseconds}ms, dur: ${total.inMilliseconds}ms)');
             _handlePlaybackEnded();
          }
        }

        if (_lyricProvider?.isPageOpen == true) {
          _lyricProvider?.updateHighlight(pos);
        }
        
        if (sec > 0 && sec % 5 == 0 && sec != _lastSavedSecond) {
          _lastSavedSecond = sec;
          _savePlaybackState();
        }
      } catch (_) {}
    }));

    _subscriptions.add(_player.volumeStream.listen((v) {
      if (_isDisposed || _isInternalChanging) return;
      try {
        if (_fadeTimer == null || !_fadeTimer!.isActive) {
          _userVolumeController.add(v);
          if (v > 0.001) {
            _lastVolume = v;
            _volumeSaveTimer?.cancel();
            _volumeSaveTimer = Timer(const Duration(milliseconds: 1000), () {
              if (!_isDisposed) _persistenceProvider?.updatePlayerSetting('volume', v);
            });
          }
        }
      } catch (_) {}
    }));
  }

  bool _isHandlingEnd = false;
  void _handlePlaybackEnded() {
    if (_isHandlingEnd || _isDisposed) return;
    _isHandlingEnd = true;
    
    _player.pause(); 
    
    Future.delayed(const Duration(milliseconds: 500), () {
      _isHandlingEnd = false;
      if (_isDisposed) return;
      
      if (_playMode != 'repeat-once') {
        next();
      } else {
        _player.seek(Duration.zero);
        _player.play();
      }
    });
  }

  void _cancelSubscriptions() {
    _fadeTimer?.cancel();
    _volumeSaveTimer?.cancel();
    for (var sub in _subscriptions) {
      sub.cancel();
    }
    _subscriptions.clear();
  }

  void _safeNotify() {
    if (!_isDisposed) {
      notifyListeners();
      _updateWakelock();
    }
  }

  void _updateWakelock() {
    if (_isDisposed) return;
    final preventSleep = _persistenceProvider?.settings['preventSleep'] ?? true;
    final isPlaying = _player.playing;
    WakelockPlus.toggle(enable: preventSleep && isPlaying);
  }

  void setLyricProvider(LyricProvider p) => _lyricProvider = p;

  void setPersistenceProvider(PersistenceProvider p) {
    _persistenceProvider = p;
    _updateWakelock();
    final savedVol = p.volume;
    _player.setVolume(savedVol);
    _userVolumeController.add(savedVol);
    _lastVolume = savedVol > 0.001 ? savedVol : 0.5;
    _playMode = p.playerSettings['playMode'] ?? 'repeat';
    
    if (_currentIndex == -1 && p.playlist.isNotEmpty) {
      _playlist = List.from(p.playlist);
      _originalPlaylist = []; 
      _currentIndex = p.currentIndex;
      if (_currentIndex >= 0 && _currentIndex < _playlist.length) {
        _currentSong = _playlist[_currentIndex];
        _safeNotify();
        WidgetsBinding.instance.addPostFrameCallback((_) {
          _initRestore();
        });
      }
    }
    
    _applyPlayMode();
  }

  Future<void> _initRestore() async {
    if (_currentSong == null) return;
    _isLoading = true;
    _safeNotify();
    try {
      final result = await _getAudioUrlWithQuality(_currentSong!);
      if (result != null && result['url'] != null) {
        await _player.setAudioSource(
          AudioSource.uri(
            Uri.parse(result['url']),
            tag: MediaItem(
              id: _currentSong!.hash,
              album: _currentSong!.albumName,
              title: _currentSong!.name,
              artist: _currentSong!.singerName,
              artUri: Uri.parse(_currentSong!.cover),
              duration: Duration(seconds: _currentSong!.duration.toInt()),
            ),
          ),
        );

        _player.setSpeed(_playbackRate);
        _fetchClimax(_currentSong!);
      }
    } catch (e) {
      LoggerService.e('Restore error: $e');
    } finally {
      _isLoading = false;
      _safeNotify();
    }
  }

  void _savePlaybackState() {
    if (_persistenceProvider != null && _playlist.isNotEmpty) {
      _persistenceProvider!.savePlaybackState(
        _playlist,
        _currentIndex,
      );
    }
  }

  void setVolume(double v) {
    if (_isDisposed) return;
    _fadeTimer?.cancel(); 
    _fadeTimer = null;
    _player.setVolume(v);
    _userVolumeController.add(v);
    if (v > 0.001) _lastVolume = v;
    _volumeSaveTimer?.cancel();
    _volumeSaveTimer = Timer(const Duration(milliseconds: 500), () {
      if (!_isDisposed && v > 0.001) {
        _persistenceProvider?.updatePlayerSetting('volume', v);
      }
    });
  }

  void toggleMute() {
    if (_player.volume > 0.01) {
      _lastVolume = _player.volume;
      _isInternalChanging = true;
      _player.setVolume(0.0);
      _userVolumeController.add(0.0);
      _isInternalChanging = false;
    } else {
      final target = _lastVolume > 0.001 ? _lastVolume : (_persistenceProvider?.volume ?? 0.5);
      setVolume(target);
    }
  }

  void setPlaybackRate(double r) {
    _playbackRate = r;
    _player.setSpeed(r);
    _safeNotify();
  }

  void setPlayMode(String mode) {
    _playMode = mode;
    _persistenceProvider?.updatePlayerSetting('playMode', mode);
    _applyPlayMode();
    _safeNotify();
  }

  void _applyPlayMode() {
    if (_playMode == 'repeat-once') {
      _player.setLoopMode(LoopMode.one);
    } else {
      _player.setLoopMode(LoopMode.off);
    }

    if (_playMode == 'shuffle' && _playlist.isNotEmpty) {
      if (_originalPlaylist.isEmpty) {
        _originalPlaylist = List.from(_playlist);
        final current = _currentSong;
        _playlist.shuffle();
        if (current != null) {
          _playlist.removeWhere((s) => s.isSameSong(current));
          _playlist.insert(0, current);
          _currentIndex = 0;
        }
      }
    } else if (_originalPlaylist.isNotEmpty) {
      final current = _currentSong;
      _playlist = List.from(_originalPlaylist);
      _originalPlaylist = [];
      if (current != null) {
        _currentIndex = _playlist.indexWhere((s) => s.isSameSong(current));
      }
    }
  }

  void togglePlayMode() {
    if (_playMode == 'repeat') setPlayMode('repeat-once');
    else if (_playMode == 'repeat-once') setPlayMode('shuffle');
    else setPlayMode('repeat');
  }

  Future<void> playSong(Song song, {List<Song>? playlist}) async {
    if (_isDisposed) return;
    if (playlist != null) {
      _playlist = List.from(playlist);
      _originalPlaylist = [];
      if (_playMode == 'shuffle') {
        _originalPlaylist = List.from(playlist);
        _playlist.shuffle();
        _playlist.removeWhere((s) => s.isSameSong(song));
        _playlist.insert(0, song);
      }
    }
    _currentIndex = _playlist.indexWhere((s) => s.isSameSong(song));
    _currentSong = song;
    _safeNotify();

    _isLoading = true;
    _safeNotify();

    try {
      _persistenceProvider?.addToHistory(song);
      MusicApi.uploadPlayHistory(song.mixSongId);
      _fetchClimax(song);
      final result = await _getAudioUrlWithQuality(song);
      
      if (_isDisposed) return;
      
      if (result == null || result['url'] == null) {
        LoggerService.e('[AudioProvider] Failed to get URL for ${song.name}, skipping to next.');
        Future.delayed(const Duration(seconds: 1), () => next());
        return;
      }

      // Preparation for fade-in: Start at volume 0 and mark as internal change
      _isInternalChanging = true;
      _player.setVolume(0.0);
      
      await _player.setAudioSource(
        AudioSource.uri(
          Uri.parse(result['url']),
          tag: MediaItem(
            id: song.hash,
            album: song.albumName,
            title: song.name,
            artist: song.singerName,
            artUri: Uri.parse(song.cover),
            duration: Duration(seconds: song.duration.toInt()),
          ),
        ),
      );
      
      _player.setSpeed(_playbackRate);
      _player.play();
      
      // Start fade-in to the target volume
      _fadeVolume(_persistenceProvider?.volume ?? 0.5, from: 0.0);
      
      _applyPlayMode(); 
      _savePlaybackState();
    } catch (e) {
      _handlePlayError(e);
    } finally {
      _isLoading = false;
      _safeNotify();
    }
  }

  Future<Map<String, dynamic>?> _getAudioUrlWithQuality(Song song) async {
    if (song.source == 'cloud') {
      final url = await MusicApi.getCloudSongUrl(song.hash);
      return url != null ? {'url': url} : null;
    }

    final settings = _persistenceProvider?.settings ?? {};
    final playerSettings = _persistenceProvider?.playerSettings ?? {};
    
    final audioQuality = playerSettings['audioQuality'] ?? settings['audioQuality'] ?? 'flac';
    final audioEffect = playerSettings['audioEffect'] ?? settings['audioEffect'] ?? 'none';
    final backupQuality = settings['backupQuality'] ?? '128';
    final compatibilityMode = settings['compatibilityMode'] ?? true;

    final List<String> qualityList = [];
    if (audioEffect != 'none') qualityList.add(audioEffect);
    qualityList.add(audioQuality);
    if (compatibilityMode) qualityList.add(backupQuality);
    
    final uniqueQualities = qualityList.toSet().toList();

    final privilege = await MusicApi.getSongPrivilege(song.hash);
    final List<dynamic> relateGoods = (privilege.isNotEmpty) ? (privilege[0]['relate_goods'] ?? []) : [];

    for (final quality in uniqueQualities) {
      try {
        final isEffect = app_const.AudioEffect.options.any((e) => e.value == quality && e.value != 'none');
        
        String targetHash = song.hash;
        if (!isEffect) {
          final good = relateGoods.firstWhere((item) => item['quality']?.toString() == quality, orElse: () => null);
          if (good != null && good['hash'] != null) {
            targetHash = good['hash'];
          } else {
            if (quality != audioQuality) continue;
          }
        }

        final result = await MusicApi.getSongUrl(targetHash, quality: quality);
        if (result != null && result['status'] == 1 && result['url'] != null) {
          return result;
        }
      } catch (_) {}
    }

    if (compatibilityMode) {
      final lastResort = await MusicApi.getSongUrl(song.hash);
      if (lastResort != null && lastResort['url'] != null) return lastResort;
    }

    return null;
  }

  Future<void> _handlePlayError(dynamic err) async {
    if (_isDisposed) return;
    LoggerService.e('[AudioProvider] Playback error: $err');

    final settings = _persistenceProvider?.settings ?? {};
    final autoNext = settings['autoNext'] ?? true;
    final autoNextTime = settings['autoNextTime'] ?? 3000;

    if (autoNext) {
      LoggerService.i('[AudioProvider] Auto-next enabled. Waiting ${autoNextTime}ms before skipping.');
      await Future.delayed(Duration(milliseconds: autoNextTime));
      next();
    }
  }

  Future<void> updateAudioSetting(String key, String value) async {
    _persistenceProvider?.updatePlayerSetting(key, value);
    if (_currentSong != null) {
      final pos = _player.position;
      final playing = _player.playing;
      _isLoading = true;
      _safeNotify();
      try {
        final result = await _getAudioUrlWithQuality(_currentSong!);
        if (result != null && result['url'] != null) {
          await _player.setAudioSource(
            AudioSource.uri(
              Uri.parse(result['url']),
              tag: MediaItem(
                id: _currentSong!.hash,
                album: _currentSong!.albumName,
                title: _currentSong!.name,
                artist: _currentSong!.singerName,
                artUri: Uri.parse(_currentSong!.cover),
                duration: Duration(seconds: _currentSong!.duration.toInt()),
              ),
            ),
          );
          await _player.seek(pos);
          if (playing) _player.play();
          _player.setSpeed(_playbackRate);
        }
      } catch (_) {
      } finally {
        _isLoading = false;
        _safeNotify();
      }
    }
  }

  void togglePlay() {
    if (_player.playing) {
      _fadeVolume(0.0, onComplete: () {
        _player.pause();
        _savePlaybackState();
      });
    } else {
      _player.setVolume(0.0);
      _player.play();
      _fadeVolume(_persistenceProvider?.volume ?? 0.5, from: 0.0);
    }
  }

  void stop() {
    _fadeVolume(0.0, onComplete: () {
      _player.stop();
      _savePlaybackState();
      _safeNotify();
    });
  }

  void next() {
    if (_playlist.isEmpty) return;
    if (_player.loopMode == LoopMode.one) {
       _player.seek(Duration.zero);
       _player.play();
       return;
    }
    
    if (_player.playing) {
      _fadeVolume(0.0, onComplete: () {
        _currentIndex = (_currentIndex + 1) % _playlist.length;
        playSong(_playlist[_currentIndex]);
      });
    } else {
      _currentIndex = (_currentIndex + 1) % _playlist.length;
      playSong(_playlist[_currentIndex]);
    }
  }

  void previous() {
    if (_playlist.isEmpty) return;
    
    if (_player.playing) {
      _fadeVolume(0.0, onComplete: () {
        _currentIndex = (_currentIndex - 1 + _playlist.length) % _playlist.length;
        playSong(_playlist[_currentIndex]);
      });
    } else {
      _currentIndex = (_currentIndex - 1 + _playlist.length) % _playlist.length;
      playSong(_playlist[_currentIndex]);
    }
  }

  void clearPlaylist() {
    _playlist = [];
    _originalPlaylist = [];
    _currentIndex = -1;
    _savePlaybackState();
    _safeNotify();
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
    if (_playMode == 'shuffle') _originalPlaylist.removeWhere((s) => s.isSameSong(removed));
    _savePlaybackState();
    _safeNotify();
  }

  Future<void> fetchLyrics() async {
    final song = _currentSong;
    if (song == null) return;
    final searchResult = await MusicApi.searchLyric(song.hash);
    final target = (searchResult?['candidates']?.isNotEmpty ?? false) ? searchResult!['candidates'][0] : (searchResult?['info']?.isNotEmpty ?? false ? searchResult!['info'][0] : null);
    if (target != null) {
      final lyricData = await MusicApi.getLyric(target['id']?.toString() ?? '', target['accesskey']?.toString() ?? '');
      if (lyricData != null) {
        _lyricProvider?.parseLyrics(lyricData, hash: song.hash);
        _lyricProvider?.updateHighlight(_player.position);
      }
    }
  }

  Future<void> _fetchClimax(Song song) async {
    final Map<double, double> newMarks = {};
    try {
      final result = await MusicApi.getSongClimaxRaw(song.hash);
      final songDur = song.duration > 0 ? song.duration : 1;
      for (var item in result) {
        final start = item['start_time'] ?? item['starttime'];
        final end = item['end_time'] ?? item['endtime'];
        if (start != null) {
          final startTime = start is String ? int.parse(start) : (start as num).toInt();
          final endTime = end != null 
              ? (end is String ? int.parse(end) : (end as num).toInt())
              : startTime + 15000;
          newMarks[startTime / 1000 / songDur] = endTime / 1000 / songDur;
        }
      }
      _climaxMarks = newMarks;
      _safeNotify();
    } catch (_) {}
  }

  @override
  void dispose() {
    _isDisposed = true;
    _fadeTimer?.cancel();
    _volumeSaveTimer?.cancel();
    _cancelSubscriptions();
    _userVolumeController.close();
    WakelockPlus.disable();
    _player.dispose();
    super.dispose();
  }
}
