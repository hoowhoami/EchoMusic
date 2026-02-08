import 'dart:async';
import 'package:flutter/material.dart';
import 'package:media_kit/media_kit.dart';
import '../models/song.dart';
import '../api/music_api.dart';
import '../utils/constants.dart';
import 'lyric_provider.dart';
import 'persistence_provider.dart';

class AudioProvider with ChangeNotifier {
  late final Player _player = Player();

  // Getter for external use
  Player get player => _player;

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
  final Map<double, double> _climaxMarks = {};

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
  bool get isPlaying => _player.state.playing;
  bool get isLoading => _isLoading || _player.state.buffering;
  String get playMode => _playMode;
  String get loopMode => _playMode; // Alias for potential dynamic lookup
  double get playbackRate => _playbackRate;
  Map<double, double> get climaxMarks => _climaxMarks;
  Stream<double> get userVolumeStream => _userVolumeController.stream;

  AudioProvider() {
    _initListeners();
  }

  void _fadeVolume(double target, {int? durationMs, VoidCallback? onComplete}) {
    _fadeTimer?.cancel();
    if (_persistenceProvider?.settings['volumeFade'] == false) {
      _player.setVolume(target * 100.0);
      onComplete?.call();
      return;
    }

    final startVolume = _player.state.volume / 100.0;
    final duration = durationMs ?? _persistenceProvider?.settings['volumeFadeTime'] ?? 500;
    if (duration <= 0) {
      _player.setVolume(target * 100.0);
      onComplete?.call();
      return;
    }

    _isInternalChanging = true;
    const steps = 20;
    final stepDuration = duration ~/ steps;
    final volumeStep = (target - startVolume) / steps;
    int currentStep = 0;

    _fadeTimer = Timer.periodic(Duration(milliseconds: stepDuration), (timer) {
      currentStep++;
      final newVolume = (startVolume + volumeStep * currentStep).clamp(0.0, 1.0);
      _player.setVolume(newVolume * 100.0);
      if (currentStep >= steps) {
        timer.cancel();
        _fadeTimer = null;
        _player.setVolume(target * 100.0);
        _isInternalChanging = false;
        onComplete?.call();
      }
    });
  }

  int _lastSavedSecond = -1;

  void _initListeners() {
    _subscriptions.add(_player.stream.completed.listen((c) {
      if (_isDisposed || !c) return;
      try {
        next();
      } catch (_) {}
    }));

    _subscriptions.add(_player.stream.playing.listen((_) => _safeNotify()));
    _subscriptions.add(_player.stream.buffering.listen((_) => _safeNotify()));
    _subscriptions.add(_player.stream.error.listen((_) => _handlePlayError()));

    _subscriptions.add(_player.stream.position.listen((pos) {
      if (_isDisposed) return;
      final sec = pos.inSeconds;
      try {
        if (_lyricProvider?.isPageOpen == true) _lyricProvider?.updateHighlight(pos);
        // Periodically save state (every 5 seconds)
        if (sec > 0 && sec % 5 == 0 && sec != _lastSavedSecond) {
          _lastSavedSecond = sec;
          _savePlaybackState();
        }
      } catch (_) {}
    }));

    _subscriptions.add(_player.stream.volume.listen((v) {
      if (_isDisposed || _isInternalChanging) return;
      try {
        final normalized = v / 100.0;
        // Broadcast for UI smoothness
        if (_fadeTimer == null || !_fadeTimer!.isActive) {
          _userVolumeController.add(normalized);
          // Auto-save volume from external changes (e.g. keyboard shortcuts)
          if (normalized > 0.001) {
            _lastVolume = normalized;
            _volumeSaveTimer?.cancel();
            _volumeSaveTimer = Timer(const Duration(milliseconds: 1000), () {
              if (!_isDisposed) _persistenceProvider?.updatePlayerSetting('volume', normalized);
            });
          }
        }
      } catch (_) {}
    }));
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
    if (!_isDisposed) notifyListeners();
  }

  void setLyricProvider(LyricProvider p) => _lyricProvider = p;

  void setPersistenceProvider(PersistenceProvider p) {
    _persistenceProvider = p;
    final savedVol = p.volume;
    _player.setVolume(savedVol * 100.0);
    _userVolumeController.add(savedVol);
    _lastVolume = savedVol > 0.001 ? savedVol : 0.5;
    _playMode = p.playerSettings['playMode'] ?? 'repeat';
    
    // Restore playback state if not already playing
    if (_currentIndex == -1 && p.playlist.isNotEmpty) {
      _playlist = List.from(p.playlist);
      _originalPlaylist = []; 
      _currentIndex = p.currentIndex;
      if (_currentIndex >= 0 && _currentIndex < _playlist.length) {
        _currentSong = _playlist[_currentIndex];
        // Ensure UI updates before restoration begins
        WidgetsBinding.instance.addPostFrameCallback((_) {
          _initRestore(p.currentPosition);
        });
      }
    }
    
    _applyPlayMode();
  }

  Future<void> _initRestore(double positionSeconds) async {
    if (_currentSong == null) return;
    _isLoading = true;
    _safeNotify();
    try {
      final result = await _getAudioUrlWithQuality(_currentSong!);
      if (result != null && result['url'] != null) {
        await _player.open(Media(result['url']), play: false);
        await _player.seek(Duration(milliseconds: (positionSeconds * 1000).toInt()));
        _player.setRate(_playbackRate);
        _fetchClimax(_currentSong!);
      }
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
        _player.state.position.inMilliseconds / 1000.0,
      );
    }
  }

  void setVolume(double v) {
    if (_isDisposed) return;
    _fadeTimer?.cancel(); 
    _fadeTimer = null;
    
    // Update real-time player
    _player.setVolume(v * 100.0);
    
    // Smooth UI Update
    _userVolumeController.add(v);

    if (v > 0.001) _lastVolume = v;
    
    // Debounced Persistence to prevent lag
    _volumeSaveTimer?.cancel();
    _volumeSaveTimer = Timer(const Duration(milliseconds: 500), () {
      if (!_isDisposed && v > 0.001) {
        _persistenceProvider?.updatePlayerSetting('volume', v);
      }
    });
  }

  void toggleMute() {
    if (_player.state.volume > 0.1) {
      _lastVolume = _player.state.volume / 100.0;
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
    _player.setRate(r);
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
      _player.setPlaylistMode(PlaylistMode.single);
    } else {
      _player.setPlaylistMode(PlaylistMode.none);
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
      if (_isDisposed || result == null || result['url'] == null) return;

      _isInternalChanging = true;
      _player.setVolume(0.0);
      await _player.open(Media(result['url']), play: true);
      _player.setRate(_playbackRate);
      _isInternalChanging = false;
      _applyPlayMode(); 
      
      _fadeVolume(_persistenceProvider?.volume ?? 0.5);
      _savePlaybackState();
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

    // Build priority list
    final List<String> qualityList = [];
    if (audioEffect != 'none') qualityList.add(audioEffect);
    qualityList.add(audioQuality);
    if (compatibilityMode) qualityList.add(backupQuality);
    
    final uniqueQualities = qualityList.toSet().toList();

    final privilege = await MusicApi.getSongPrivilege(song.hash);
    final List<dynamic> relateGoods = (privilege.isNotEmpty) ? (privilege[0]['relate_goods'] ?? []) : [];

    for (final quality in uniqueQualities) {
      try {
        final isEffect = AudioEffect.options.any((e) => e.value == quality && e.value != 'none');
        
        String targetHash = song.hash;
        if (!isEffect) {
          final good = relateGoods.firstWhere((item) => item['quality']?.toString() == quality, orElse: () => null);
          if (good != null && good['hash'] != null) {
            targetHash = good['hash'];
          } else {
            // If we can't find the hash for this quality level, skip it unless it's the primary one
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

  Future<void> _handlePlayError() async {
    if (_isDisposed) return;
    
    final settings = _persistenceProvider?.settings ?? {};
    final autoNext = settings['autoNext'] ?? true;
    final autoNextTime = settings['autoNextTime'] ?? 3000;

    if (autoNext) {
      await Future.delayed(Duration(milliseconds: autoNextTime));
      next();
    }
  }

  Future<void> updateAudioSetting(String key, String value) async {
    _persistenceProvider?.updatePlayerSetting(key, value);
    if (_currentSong != null) {
      final pos = _player.state.position;
      final playing = _player.state.playing;
      _isLoading = true;
      _safeNotify();
      try {
        final result = await _getAudioUrlWithQuality(_currentSong!);
        if (result != null && result['url'] != null) {
          await _player.open(Media(result['url']), play: playing);
          await _player.seek(pos);
          _player.setRate(_playbackRate);
        }
      } finally {
        _isLoading = false;
        _safeNotify();
      }
    }
  }

  void togglePlay() {
    if (_player.state.playing) {
      _fadeVolume(0.0, onComplete: () {
        _player.pause();
        _savePlaybackState();
      });
    } else {
      _player.play();
      _fadeVolume(_persistenceProvider?.volume ?? 0.5);
    }
  }

  void next() {
    if (_playlist.isEmpty) return;
    if (_playMode == 'repeat-once') {
       _player.seek(Duration.zero);
       _player.play();
       return;
    }
    _fadeVolume(0.0, onComplete: () {
      _currentIndex = (_currentIndex + 1) % _playlist.length;
      playSong(_playlist[_currentIndex]);
    });
  }

  void previous() {
    if (_playlist.isEmpty) return;
    _fadeVolume(0.0, onComplete: () {
      _currentIndex = (_currentIndex - 1 + _playlist.length) % _playlist.length;
      playSong(_playlist[_currentIndex]);
    });
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
      if (lyricData != null) _lyricProvider?.parseLyrics(lyricData, hash: song.hash);
    }
  }

  Future<void> _fetchClimax(Song song) async {
    _climaxMarks.clear();
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
          _climaxMarks[startTime / 1000 / songDur] = endTime / 1000 / songDur;
        }
      }
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
    _player.dispose(); // CRITICAL: Fix crash on exit
    super.dispose();
  }
}
