import 'dart:async';
import 'package:flutter/material.dart';
import 'package:media_kit/media_kit.dart';
import '../models/song.dart';
import '../api/music_api.dart';
import 'lyric_provider.dart';
import 'persistence_provider.dart';

class AudioProvider with ChangeNotifier {
  final Player player = Player();
  final List<StreamSubscription> _subscriptions = [];
  final StreamController<double> _userVolumeController = StreamController<double>.broadcast();

  Song? _currentSong;
  List<Song> _playlist = [];
  List<Song> _originalPlaylist = [];
  int _currentIndex = -1;
  bool _isLoading = false;
  bool _isShuffle = false;
  bool _isDisposed = false;
  double _playbackRate = 1.0;
  final Map<double, String> _climaxMarks = {};

  LyricProvider? _lyricProvider;
  PersistenceProvider? _persistenceProvider;

  // Getters
  Song? get currentSong => _currentSong;
  List<Song> get playlist => _playlist;
  int get currentIndex => _currentIndex;
  bool get isPlaying => player.state.playing;
  bool get isLoading => _isLoading || player.state.buffering;
  PlaylistMode get loopMode => player.state.playlistMode;
  bool get isShuffle => _isShuffle;
  double get playbackRate => _playbackRate;
  Map<double, String> get climaxMarks => _climaxMarks;
  Stream<double> get userVolumeStream => _userVolumeController.stream;

  AudioProvider() {
    _initListeners();
  }

  void _initListeners() {
    _subscriptions.add(player.stream.completed.listen((c) {
      if (_isDisposed || !c) return;
      loopMode == PlaylistMode.single ? player.seek(Duration.zero) : next();
    }));

    _subscriptions.add(player.stream.playing.listen((_) => _safeNotify()));
    _subscriptions.add(player.stream.buffering.listen((_) => _safeNotify()));
    
    _subscriptions.add(player.stream.position.listen((pos) {
      if (_isDisposed) return;
      if (_lyricProvider?.isPageOpen == true) _lyricProvider?.updateHighlight(pos);
    }));

    _subscriptions.add(player.stream.volume.listen((v) {
      if (_isDisposed) return;
      final normalized = v / 100.0;
      _persistenceProvider?.saveVolume(normalized);
      _userVolumeController.add(normalized);
    }));
  }

  void _safeNotify() {
    if (!_isDisposed) notifyListeners();
  }

  void setLyricProvider(LyricProvider p) => _lyricProvider = p;
  void setPersistenceProvider(PersistenceProvider p) {
    _persistenceProvider = p;
    player.setVolume(p.volume * 100.0);
    _userVolumeController.add(p.volume);
  }

  void setVolume(double v) {
    if (_isDisposed) return;
    player.setVolume(v * 100.0);
  }

  void setPlaybackRate(double r) {
    _playbackRate = r;
    player.setRate(r);
    _safeNotify();
  }

  void toggleLoopMode() {
    final mode = player.state.playlistMode;
    final nextMode = mode == PlaylistMode.none ? PlaylistMode.loop : (mode == PlaylistMode.loop ? PlaylistMode.single : PlaylistMode.none);
    player.setPlaylistMode(nextMode);
    _safeNotify();
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
    _safeNotify();
  }

  Future<void> playSong(Song song, {List<Song>? playlist}) async {
    if (_isDisposed) return;
    if (playlist != null) {
      _playlist = List.from(playlist);
      _originalPlaylist = List.from(playlist);
      if (_isShuffle) _playlist.shuffle();
    }
    _currentIndex = _playlist.indexWhere((s) => s.hash == song.hash);
    _currentSong = song;
    _safeNotify();

    _isLoading = true;
    _safeNotify();

    try {
      _persistenceProvider?.addToHistory(song);
      _fetchClimax(song);
      final result = await _getAudioUrlWithQuality(song);
      if (_isDisposed || result == null || result['url'] == null) return;

      await player.open(Media(result['url']), play: true);
      player.setRate(_playbackRate);
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
    // 尝试获取设置中的音质
    final settings = _persistenceProvider?.settings ?? {};
    final quality = settings['audioQuality'] ?? 'flac';
    final result = await MusicApi.getSongUrl(song.hash, quality: quality);
    if (result != null && result['url'] != null) return {'url': result['url']};
    
    // 备选音质
    final backup = await MusicApi.getSongUrl(song.hash);
    return (backup != null && backup['url'] != null) ? {'url': backup['url']} : null;
  }

  void togglePlay() => player.playOrPause();
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
    _safeNotify();
  }

  void removeFromPlaylist(int index) {
    if (index < 0 || index >= _playlist.length) return;
    final removed = _playlist[index];
    _playlist.removeAt(index);
    if (_currentIndex == index) {
      if (_playlist.isEmpty) {
        _currentSong = null;
        player.stop();
      } else {
        _currentIndex = _currentIndex % _playlist.length;
        playSong(_playlist[_currentIndex]);
      }
    } else if (_currentIndex > index) {
      _currentIndex--;
    }
    if (_isShuffle) _originalPlaylist.removeWhere((s) => s.hash == removed.hash);
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
      for (var item in result) {
        final start = item['start_time'] ?? item['starttime'];
        if (start != null) {
          final time = start is String ? int.parse(start) : (start as num).toInt();
          _climaxMarks[time / 1000 / (song.duration > 0 ? song.duration : 1)] = '';
        }
      }
      _safeNotify();
    } catch (_) {}
  }

  @override
  void dispose() {
    _isDisposed = true;
    for (var sub in _subscriptions) {
      sub.cancel();
    }
    _subscriptions.clear();
    _userVolumeController.close();
    player.stop(); // 停止播放但不立即销毁，以缓解开发环境下的 FFI 竞争
    super.dispose();
  }
}