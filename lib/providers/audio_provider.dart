import 'dart:async';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:media_kit/media_kit.dart';
import 'package:wakelock_plus/wakelock_plus.dart';
import '../models/song.dart';
import '../api/music_api.dart';
import '../utils/logger.dart';
import '../utils/media_session_handler.dart';
import 'lyric_provider.dart';
import 'persistence_provider.dart';

/// Snapshot of position + duration emitted together so the two values
/// are always consistent and never show a mismatch in the progress bar.
class PositionSnapshot {
  final Duration position;
  final Duration duration;
  const PositionSnapshot(this.position, this.duration);
}

class AudioProvider with ChangeNotifier {
  late Player _player;

  // Getter for external use
  Player get player => _player;

  // Single stream that the UI listens to for position/duration updates.
  // We drive it ourselves so we control exactly when and what gets emitted.
  final StreamController<PositionSnapshot> _positionController =
      StreamController<PositionSnapshot>.broadcast();
  Stream<PositionSnapshot> get positionSnapshotStream =>
      _positionController.stream;

  final List<StreamSubscription> _subscriptions = [];
  final StreamController<double> _userVolumeController =
      StreamController<double>.broadcast();

  Song? _currentSong;
  List<Song> _playlist = [];
  List<Song> _originalPlaylist = [];
  int _currentIndex = -1;
  bool _isLoading = false;
  bool _isDisposed = false;
  double _playbackRate = 1.0;
  double _lastVolume = 50.0;
  Map<double, double> _climaxMarks = {};

  String _playMode = 'repeat'; // 'repeat', 'repeat-once', 'shuffle'

  LyricProvider? _lyricProvider;
  PersistenceProvider? _persistenceProvider;

  Timer? _fadeTimer;
  Timer? _volumeSaveTimer;
  bool _isInternalChanging = false;

  // True while _player.seek() is in flight. We suppress positionStream events
  // during this window so stale pre-seek positions never reach the UI.
  bool _isSeeking = false;

  // Timestamp of last seek, used to ignore false "completed" events shortly after seek
  DateTime? _lastSeekTime;

  // True while the user is dragging the thumb. We suppress positionStream
  // events so the progress bar total cannot change under the user's finger.
  bool _isDragging = false;

  // Last position forwarded to the UI stream (used for 200 ms throttle).
  Duration _lastEmittedPosition = Duration.zero;

  // Previous device list snapshot for connect/disconnect detection.
  Set<String> _lastDeviceNames = {};

  // Last wakelock state sent to the platform; avoids redundant platform channel calls.
  bool _lastWakelockEnabled = false;

  // Tracks the device the user explicitly selected; null means 'auto'.
  AudioDevice? _userSelectedDevice;

  // Persisted preferred device: name = libmpv ID (for matching), description = display label.
  // Tracked dynamically: switches to preferred when it appears, falls back to auto when it disappears.
  String? _preferredDeviceName;
  String? _preferredDeviceDescription;

  // Flag to mark device-related errors (should not trigger auto-next)
  bool _isDeviceError = false;

  // Getters
  Song? get currentSong => _currentSong;
  List<Song> get playlist => _playlist;
  int get currentIndex => _currentIndex;
  bool get isPlaying => _player.state.playing;
  bool get isLoading => _isLoading || _player.state.buffering;
  String get playMode => _playMode;
  String get loopMode => _playMode;
  double get playbackRate => _playbackRate;
  Map<double, double> get climaxMarks => _climaxMarks;
  Stream<double> get userVolumeStream => _userVolumeController.stream;
  List<AudioDevice> get audioDevices => _player.state.audioDevices;
  AudioDevice get currentAudioDevice => _player.state.audioDevice;
  // The device the user explicitly chose; null means 'auto'.
  AudioDevice? get userSelectedDevice => _userSelectedDevice;
  // Display label of the persisted preferred device (for UI when device is unavailable).
  String? get preferredDeviceDescription => _preferredDeviceDescription;
  // True when a preferred device is saved but not currently active (unavailable or not yet restored).
  bool get isPreferredDeviceUnavailable =>
      _preferredDeviceName != null && _userSelectedDevice?.name != _preferredDeviceName;
  // True when the user has a saved preferred device (not pure auto mode).
  bool get hasPreferredDevice => _preferredDeviceName != null;

  Duration get effectivePosition => _player.state.position;

  Duration get effectiveDuration {
    final d = _player.state.duration;
    if (d > Duration.zero) return d;
    if (_currentSong != null && _currentSong!.duration > 0) {
      return Duration(seconds: _currentSong!.duration);
    }
    return Duration.zero;
  }

  AudioProvider() {
    _player = Player();
    _initListeners();
    _initMediaSession();
  }

  Future<void> _initMediaSession() async {
    await MediaSessionHandler.init(
      onPlay: () => togglePlay(),
      onPause: () => togglePlay(),
      onNext: () => next(),
      onPrevious: () => previous(),
      onSeek: (pos) => seek(pos),
    );
  }

  // Internal volume helpers: AudioProvider public API uses 0-100 scale (matching media_kit).
  void _fadeVolume(double target, {double? from, int? durationMs, VoidCallback? onComplete}) {
    _fadeTimer?.cancel();
    _fadeTimer = null;

    final bool isFadeEnabled = _persistenceProvider?.settings['volumeFade'] ?? true;

    if (!isFadeEnabled) {
      _player.setVolume(target);
      _isInternalChanging = false;
      onComplete?.call();
      return;
    }

    final double startVolume = from ?? _player.state.volume;
    final int duration = durationMs ?? _persistenceProvider?.settings['volumeFadeTime'] ?? 1000;

    if (duration <= 0 || (target - startVolume).abs() < 1.0) {
      _player.setVolume(target);
      _isInternalChanging = false;
      onComplete?.call();
      return;
    }

    _isInternalChanging = true;
    const int stepMs = 20;
    final int totalSteps = (duration / stepMs).round().clamp(1, 9999);
    final double volumeStep = (target - startVolume) / totalSteps;
    int currentStep = 0;

    _fadeTimer = Timer.periodic(const Duration(milliseconds: stepMs), (timer) {
      if (_isDisposed) {
        timer.cancel();
        _fadeTimer = null;
        return;
      }
      currentStep++;
      final nextVol = (startVolume + volumeStep * currentStep).clamp(0.0, 100.0);
      _player.setVolume(nextVol);
      if (currentStep >= totalSteps) {
        timer.cancel();
        _fadeTimer = null;
        _player.setVolume(target);
        _isInternalChanging = false;
        onComplete?.call();
      }
    });
  }

  int _lastSavedSecond = -1;
  int _lastMediaSessionSecond = -1;

  void _initListeners() {
    // Error handling
    _subscriptions.add(_player.stream.error.listen((error) {
      _handlePlayError(error);
    }));

    // Playing state changes → notify UI + MediaSession
    _subscriptions.add(_player.stream.playing.listen((playing) {
      if (_isDisposed) return;
      LoggerService.d('[AudioProvider] playing=$playing');
      _safeNotify();
      MediaSessionHandler.updatePlaybackState(playing, _player.state.position);
    }));

    // Buffering state changes → notify UI
    _subscriptions.add(_player.stream.buffering.listen((_) {
      if (_isDisposed) return;
      _safeNotify();
    }));

    // Track completed
    _subscriptions.add(_player.stream.completed.listen((completed) {
      if (_isDisposed || !completed) return;

      if (_lastSeekTime != null) {
        final sinceSeek = DateTime.now().difference(_lastSeekTime!).inMilliseconds;
        if (sinceSeek < 1000) {
          LoggerService.i('[AudioProvider] Ignoring completed event ${sinceSeek}ms after seek');
          return;
        }
      }

      final pos = _player.state.position;
      final dur = _player.state.duration;
      LoggerService.i('[AudioProvider] Playback completed normally. pos=$pos, dur=$dur');
      _handlePlaybackEnded();
      _safeNotify();
    }));

    _subscriptions.add(_player.stream.position.listen((pos) {
      if (_isDisposed) return;
      final sec = pos.inSeconds;

      try {
        // During seek or drag, suppress position events to the UI
        if (_isSeeking || _isDragging) return;

        final total = effectiveDuration;

        // Throttle: only emit to UI if position changed ≥200ms
        final diff = (pos.inMilliseconds - _lastEmittedPosition.inMilliseconds).abs();
        if (diff >= 200) {
          _lastEmittedPosition = pos;
          if (!_positionController.isClosed) {
            _positionController.add(PositionSnapshot(pos, total));
          }
        }

        // Fallback end detection: if position is very close to duration and player is playing,
        // treat as end of track.
        if (_player.state.playing && total.inMilliseconds > 0) {
          final remaining = total.inMilliseconds - pos.inMilliseconds;
          if (remaining >= 0 && remaining < 600 && !_isHandlingEnd) {
            LoggerService.i('[AudioProvider] Position near end (remaining=${remaining}ms), triggering completion: pos=$pos, dur=$total');
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

        if (sec != _lastMediaSessionSecond) {
          _lastMediaSessionSecond = sec;
          MediaSessionHandler.updatePlaybackState(_player.state.playing, pos);
        }
      } catch (_) {}
    }));

    // Audio device changes
    _subscriptions.add(_player.stream.audioDevice.listen((device) {
      if (_isDisposed) return;
      LoggerService.i('[AudioProvider] Active audio device changed → "${device.description}" (${device.name})');
      _safeNotify();
    }));

    _subscriptions.add(_player.stream.audioDevices.listen((devices) {
      if (_isDisposed) return;

      final currentNames = devices.where((d) => d.name != 'auto').map((d) => d.name).toSet();
      final connected = currentNames.difference(_lastDeviceNames);
      final disconnected = _lastDeviceNames.difference(currentNames);
      _lastDeviceNames = currentNames;

      // Only rebuild the UI when the device list actually changed.
      if (connected.isNotEmpty || disconnected.isNotEmpty) {
        _safeNotify();

        for (final name in connected) {
          final d = devices.firstWhere((d) => d.name == name);
          LoggerService.i('[AudioProvider] Device connected: "${d.description}" ($name)');
        }

        // 检测到设备断开，如果启用了暂停功能，则暂停播放
        for (final name in disconnected) {
          LoggerService.i('[AudioProvider] Device disconnected: "$name"');

          final pauseOnChange = _persistenceProvider?.settings['pauseOnDeviceChange'] ?? false;
          if (!Platform.isMacOS && _player.state.playing) {
            // 检查断开的是否是当前正在使用的设备
            final currentDevice = _player.state.audioDevice;
            if (currentDevice.name == name || currentDevice.name == 'auto') {
              // auto 模式下，任何设备断开都可能影响播放
              // 标记为设备错误，避免触发自动下一首
              _isDeviceError = true;

              if (pauseOnChange) {
                LoggerService.i('[AudioProvider] Active device disconnected, pausing playback');
                _player.pause();
              } else {
                LoggerService.i('[AudioProvider] Active device disconnected, marked as device error');
              }

              // 延迟重置标志，确保错误处理器能看到这个标志
              Future.delayed(const Duration(milliseconds: 500), () {
                _isDeviceError = false;
              });
              break; // 只需要处理一次
            }
          }
        }
      }

      // Dynamic preferred device tracking: switch to preferred when available,
      // fall back to auto when it disappears.
      if (_preferredDeviceName != null) {
        final isPreferredAvailable = currentNames.contains(_preferredDeviceName);
        final isPreferredActive = _userSelectedDevice?.name == _preferredDeviceName;

        if (isPreferredAvailable && !isPreferredActive) {
          // Preferred device appeared (initial load or reconnect) → switch to it.
          final match = devices.firstWhere((d) => d.name == _preferredDeviceName);
          _userSelectedDevice = match;
          _player.setAudioDevice(match);
          LoggerService.i('[AudioProvider] Preferred device available, switching: "${match.description}" (${match.name})');
          _safeNotify();
        } else if (!isPreferredAvailable && isPreferredActive) {
          // Preferred device disconnected → fall back to auto.
          _userSelectedDevice = null;
          _player.setAudioDevice(AudioDevice.auto());
          LoggerService.i('[AudioProvider] Preferred device disconnected, using auto');
          _safeNotify();
        }
      }
    }));

    _subscriptions.add(_player.stream.volume.listen((v) {
      if (_isDisposed || _isInternalChanging) return;
      try {
        if (_fadeTimer == null || !_fadeTimer!.isActive) {
          // Do NOT emit to _userVolumeController here. The displayed volume must
          // reflect only the user's intent, not the player's physical volume which
          // fluctuates during fades. All UI-visible volume updates go through
          // setVolume() and toggleMute() explicitly.
          if (v > 0.1) {
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

    // 如果是设备错误引起的，不触发自动下一首
    if (_isDeviceError) {
      LoggerService.i('[AudioProvider] Playback ended due to device error, skipping auto-next');
      return;
    }

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
    final shouldEnable = preventSleep && _player.state.playing;
    // Avoid redundant Win32/platform-channel calls when the state hasn't changed.
    if (shouldEnable == _lastWakelockEnabled) return;
    _lastWakelockEnabled = shouldEnable;
    WakelockPlus.toggle(enable: shouldEnable);
  }

  void setLyricProvider(LyricProvider p) => _lyricProvider = p;

  void setPersistenceProvider(PersistenceProvider p) {
    _persistenceProvider = p;
    _updateWakelock();
    final savedVol = p.volume;
    _player.setVolume(savedVol);
    _userVolumeController.add(savedVol);
    _lastVolume = savedVol > 0.1 ? savedVol : 50.0;
    _playMode = p.playerSettings['playMode'] ?? 'repeat';

    // Load the persisted preferred audio device name (applied later when the
    // device list is first populated via the audioDevices stream).
    final savedDeviceName = p.playerSettings['preferredAudioDevice'] as String?;
    if (savedDeviceName != null && savedDeviceName != 'auto') {
      _preferredDeviceName = savedDeviceName;
      _preferredDeviceDescription = p.playerSettings['preferredAudioDeviceDescription'] as String?;
    }

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
      LoggerService.i('[AudioProvider] _initRestore: ${_currentSong!.name}');
      final result = await _getAudioUrlWithQuality(_currentSong!);
      if (result != null && result['url'] != null) {
        await _player.open(Media(result['url']), play: false);
        _player.setRate(_playbackRate);
        MediaSessionHandler.updateMetadata(_currentSong, Duration(seconds: _currentSong!.duration.toInt()));
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

  /// Called by the UI when the user starts dragging the progress bar.
  void notifyDragStart() {
    _isDragging = true;
  }

  /// Called by the UI when the user releases the progress bar thumb.
  void notifyDragEnd() {
    _isDragging = false;
  }

  Future<void> seek(Duration pos) async {
    if (_isDisposed) return;

    LoggerService.d('[AudioProvider] Seeking to $pos');
    _lastSeekTime = DateTime.now();

    if (_fadeTimer != null) {
      _fadeTimer!.cancel();
      _fadeTimer = null;
      _isInternalChanging = false;
    }
    if (!_isInternalChanging) {
      _player.setVolume(_persistenceProvider?.volume ?? 50.0);
    }

    _isSeeking = true;
    _isHandlingEnd = false;

    await _player.seek(pos);

    // Poll until position reaches the target (mpv seek can have a short lag).
    const maxWaitMs = 500;
    const pollIntervalMs = 20;
    const toleranceMs = 300;
    int waited = 0;
    while (waited < maxWaitMs && !_isDisposed) {
      final currentPos = _player.state.position;
      final diff = (currentPos.inMilliseconds - pos.inMilliseconds).abs();
      if (diff <= toleranceMs) break;
      await Future.delayed(const Duration(milliseconds: pollIntervalMs));
      waited += pollIntervalMs;
    }

    _isSeeking = false;

    if (!_isDisposed && !_positionController.isClosed) {
      _lastEmittedPosition = pos;
      _positionController.add(PositionSnapshot(pos, effectiveDuration));
    }

    if (_lyricProvider?.isPageOpen == true) {
      _lyricProvider?.updateHighlight(pos);
    }
  }

  void setVolume(double v) {
    if (_isDisposed) return;
    _fadeTimer?.cancel();
    _fadeTimer = null;

    _player.setVolume(v);

    _userVolumeController.add(v);
    if (v > 0.1) _lastVolume = v;
    _volumeSaveTimer?.cancel();
    _volumeSaveTimer = Timer(const Duration(milliseconds: 500), () {
      if (!_isDisposed && v > 0.1) {
        _persistenceProvider?.updatePlayerSetting('volume', v);
      }
    });
  }

  void toggleMute() {
    if (_player.state.volume > 1.0) {
      _lastVolume = _player.state.volume;
      _isInternalChanging = true;
      _player.setVolume(0.0);
      _userVolumeController.add(0.0);
      _isInternalChanging = false;
    } else {
      final target = _lastVolume > 0.1 ? _lastVolume : (_persistenceProvider?.volume ?? 50.0);
      setVolume(target);
    }
  }

  Future<void> setAudioDevice(AudioDevice device) async {
    final isAuto = device.name == 'auto';
    _userSelectedDevice = isAuto ? null : device;
    _preferredDeviceName = isAuto ? null : device.name;
    _preferredDeviceDescription = isAuto ? null : (device.description.isNotEmpty ? device.description : device.name);
    await _player.setAudioDevice(device);
    _persistenceProvider?.updatePlayerSetting('preferredAudioDevice', isAuto ? null : device.name);
    _persistenceProvider?.updatePlayerSetting('preferredAudioDeviceDescription', _preferredDeviceDescription);
    notifyListeners();
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
    // Always PlaylistMode.none — all repetition logic is handled manually
    // via the completed stream and _handlePlaybackEnded().
    _player.setPlaylistMode(PlaylistMode.none);

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
    if (_playMode == 'repeat') {
      setPlayMode('repeat-once');
    } else if (_playMode == 'repeat-once') {
      setPlayMode('shuffle');
    } else {
      setPlayMode('repeat');
    }
  }

  Future<void> playSong(Song song, {List<Song>? playlist}) async {
    if (_isDisposed) return;

    LoggerService.i('[AudioProvider] Playing: ${song.name} - ${song.singerName} (${song.hash})');

    _fadeTimer?.cancel();
    _fadeTimer = null;
    _isInternalChanging = true;
    _player.setVolume(0.0);
    _climaxMarks = {};

    if (playlist != null) {
      LoggerService.d('[AudioProvider] Updating playlist, size: ${playlist.length}');
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
    _climaxMarks = {};
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
        LoggerService.e('[AudioProvider] Failed to get URL');

        final settings = _persistenceProvider?.settings ?? {};
        final autoNext = settings['autoNext'] ?? false;

        if (autoNext) {
          LoggerService.i('[AudioProvider] Auto-next enabled, skipping to next song in 1s');
          Future.delayed(const Duration(seconds: 1), () => next());
        }
        return;
      }

      final String url = result['url'];

      LoggerService.d('[AudioProvider] URL: $url');

      _player.setVolume(0.0);

      await _player.open(Media(url), play: false);

      LoggerService.i('[AudioProvider] Playback started');

      MediaSessionHandler.updateMetadata(song, Duration(seconds: song.duration.toInt()));

      _player.setRate(_playbackRate);
      _player.play();

      _fadeVolume(_persistenceProvider?.volume ?? 50.0, from: 0.0);

      _applyPlayMode();
      _savePlaybackState();
    } catch (e) {
      LoggerService.e('[AudioProvider] Error during playSong: $e');
      _handlePlayError(e);
    } finally {
      _isLoading = false;
      _safeNotify();
    }
  }

  Future<Map<String, dynamic>?> _getAudioUrlWithQuality(Song song) async {
    if (song.source == 'cloud') {
      LoggerService.d('[AudioProvider] Fetching cloud URL');
      final url = await MusicApi.getCloudSongUrl(song.hash);
      return url != null ? {'url': url} : null;
    }

    final settings = _persistenceProvider?.settings ?? {};
    final playerSettings = _persistenceProvider?.playerSettings ?? {};

    final audioQuality = playerSettings['audioQuality'] ?? settings['audioQuality'] ?? '128';
    final audioEffect = playerSettings['audioEffect'] ?? settings['audioEffect'] ?? 'none';
    final backupQuality = settings['backupQuality'] ?? '128';
    final compatibilityMode = settings['compatibilityMode'] ?? true;

    LoggerService.d('[AudioProvider] Quality: $audioQuality, Effect: $audioEffect, Backup: $backupQuality');

    final privilege = await MusicApi.getSongPrivilege(song.hash);
    final List<dynamic> relateGoods = (privilege.isNotEmpty) ? (privilege[0]['relate_goods'] ?? []) : [];

    // 1. 如果有音效，先尝试用音效获取
    if (audioEffect != 'none') {
      try {
        LoggerService.d('[AudioProvider] [1/4] Trying effect: $audioEffect');
        final result = await MusicApi.getSongUrl(song.hash, quality: audioEffect);
        if (result != null && result['status'] == 1 && result['url'] != null) {
          LoggerService.i('[AudioProvider] ✓ Got URL with effect: $audioEffect');
          return result;
        }
      } catch (e) {
        LoggerService.w('[AudioProvider] ✗ Effect failed: $e');
      }
    }

    // 2. 尝试用用户选择的音质获取
    try {
      LoggerService.d('[AudioProvider] [2/4] Trying quality: $audioQuality');
      String targetHash = song.hash;
      final good = relateGoods.firstWhere(
        (item) => item['quality']?.toString() == audioQuality,
        orElse: () => null
      );
      if (good != null && good['hash'] != null) {
        targetHash = good['hash'];
      }

      final result = await MusicApi.getSongUrl(targetHash, quality: audioQuality);
      if (result != null && result['status'] == 1 && result['url'] != null) {
        LoggerService.i('[AudioProvider] ✓ Got URL with quality: $audioQuality');
        return result;
      }
    } catch (e) {
      LoggerService.w('[AudioProvider] ✗ Quality failed: $e');
    }

    // 3. 如果开启了兼容模式，尝试用兜底音质获取
    if (compatibilityMode && backupQuality != audioQuality) {
      try {
        LoggerService.d('[AudioProvider] [3/4] Trying backup: $backupQuality');
        String targetHash = song.hash;
        final good = relateGoods.firstWhere(
          (item) => item['quality']?.toString() == backupQuality,
          orElse: () => null
        );
        if (good != null && good['hash'] != null) {
          targetHash = good['hash'];
        }

        final result = await MusicApi.getSongUrl(targetHash, quality: backupQuality);
        if (result != null && result['status'] == 1 && result['url'] != null) {
          LoggerService.i('[AudioProvider] ✓ Got URL with backup: $backupQuality');
          return result;
        }
      } catch (e) {
        LoggerService.w('[AudioProvider] ✗ Backup failed: $e');
      }
    }

    // 4. 最后的兜底：不指定音质，让服务器返回任何可用的
    if (compatibilityMode) {
      try {
        LoggerService.d('[AudioProvider] [4/4] Trying last resort');
        final lastResort = await MusicApi.getSongUrl(song.hash);
        if (lastResort != null && lastResort['url'] != null) {
          LoggerService.i('[AudioProvider] ✓ Got URL with last resort');
          return lastResort;
        }
      } catch (e) {
        LoggerService.w('[AudioProvider] ✗ Last resort failed: $e');
      }
    }

    LoggerService.e('[AudioProvider] ✗ All attempts failed');
    return null;
  }

  Future<void> _handlePlayError(dynamic err) async {
    if (_isDisposed) return;

    final pos = _player.state.position;
    final total = effectiveDuration;
    final remaining = total.inMilliseconds - pos.inMilliseconds;

    LoggerService.e('[AudioProvider] Playback error at pos=$pos/$total (remaining=${remaining}ms): $err');

    // 判断是否是设备相关的错误
    final isDeviceError = _isDeviceError ||
                          err.toString().toLowerCase().contains('audio device') ||
                          err.toString().toLowerCase().contains('no sound');

    if (isDeviceError) {
      LoggerService.i('[AudioProvider] Device-related error, stopping playback without auto-next');
      // 设备错误：停止播放，不触发自动下一首
      return;
    }

    // 接近结尾的错误，当作播放完成处理
    if (total.inMilliseconds > 0 && remaining < 2000) {
      LoggerService.i('[AudioProvider] Error occurred near end of song, treating as completed.');
      _handlePlaybackEnded();
      return;
    }

    // 其他播放错误：根据 autoNext 设置决定是否跳过
    final settings = _persistenceProvider?.settings ?? {};
    final autoNext = settings['autoNext'] ?? false;
    final autoNextTime = settings['autoNextTime'] ?? 3000;

    if (autoNext) {
      LoggerService.i('[AudioProvider] Playback error, auto-next enabled. Waiting ${autoNextTime}ms before skipping.');
      await Future.delayed(Duration(milliseconds: autoNextTime));
      next();
    } else {
      LoggerService.i('[AudioProvider] Playback error, auto-next disabled. Stopping playback.');
      // 不自动下一首，停止播放
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
          await _player.open(Media(result['url']), play: false);
          await _player.seek(pos);
          if (playing) _player.play();
          _player.setRate(_playbackRate);
        }
      } catch (_) {
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
      _fadeTimer?.cancel();
      _fadeTimer = null;
      _isInternalChanging = true;
      _player.setVolume(0.0);
      _player.play();
      _fadeVolume(_persistenceProvider?.volume ?? 50.0, from: 0.0);
    }
  }

  void stop() {
    _climaxMarks = {};
    _fadeVolume(0.0, onComplete: () {
      _player.stop();
      _savePlaybackState();
      _safeNotify();
    });
  }

  void reset() {
    _fadeTimer?.cancel();
    _fadeTimer = null;
    _player.stop();
    _currentSong = null;
    _playlist = [];
    _originalPlaylist = [];
    _currentIndex = -1;
    _climaxMarks = {};
    _isLoading = false;
    _savePlaybackState();
    _safeNotify();
  }

  void next() {
    if (_playlist.isEmpty) return;
    if (_playMode == 'repeat-once') {
      seek(Duration.zero);
      _player.play();
      return;
    }

    if (_player.state.playing) {
      _fadeVolume(0.0, onComplete: () {
        _player.pause();
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

    if (_player.state.playing) {
      _fadeVolume(0.0, onComplete: () {
        _player.pause();
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
    _climaxMarks = {};
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
        _climaxMarks = {};
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
        _lyricProvider?.updateHighlight(_player.state.position);
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
    _positionController.close();
    WakelockPlus.disable();
    _player.dispose();
    super.dispose();
  }
}
