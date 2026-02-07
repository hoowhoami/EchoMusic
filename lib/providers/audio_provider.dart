import 'dart:async';
import 'package:flutter/material.dart';
import 'package:media_kit/media_kit.dart';
import '../models/song.dart';
import '../api/music_api.dart';
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
  bool _isShuffle = false;
  bool _isDisposed = false;
  double _playbackRate = 1.0;
  final Map<double, double> _climaxMarks = {};

  LyricProvider? _lyricProvider;
  PersistenceProvider? _persistenceProvider;

  // Getters
  Song? get currentSong => _currentSong;
  List<Song> get playlist => _playlist;
  int get currentIndex => _currentIndex;
  bool get isPlaying => _player.state.playing;
  bool get isLoading => _isLoading || _player.state.buffering;
  PlaylistMode get loopMode => _player.state.playlistMode;
  bool get isShuffle => _isShuffle;
  double get playbackRate => _playbackRate;
  Map<double, double> get climaxMarks => _climaxMarks;
  Stream<double> get userVolumeStream => _userVolumeController.stream;

  AudioProvider() {
    _initListeners();
  }

  void _initListeners() {
    _subscriptions.add(_player.stream.completed.listen((c) {
      if (_isDisposed || !c) return;
      try {
        loopMode == PlaylistMode.single ? _player.seek(Duration.zero) : next();
      } catch (_) {}
    }));

    _subscriptions.add(_player.stream.playing.listen((_) => _safeNotify()));
    _subscriptions.add(_player.stream.buffering.listen((_) => _safeNotify()));

    _subscriptions.add(_player.stream.position.listen((pos) {
      if (_isDisposed) return;
      try {
        if (_lyricProvider?.isPageOpen == true) _lyricProvider?.updateHighlight(pos);
      } catch (_) {}
    }));

    _subscriptions.add(_player.stream.volume.listen((v) {
      if (_isDisposed) return;
      try {
        final normalized = v / 100.0;
        _persistenceProvider?.saveVolume(normalized);
        _userVolumeController.add(normalized);
      } catch (_) {}
    }));
  }

  void _cancelSubscriptions() {
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
    _player.setVolume(p.volume * 100.0);
    _userVolumeController.add(p.volume);
  }

  void setVolume(double v) {
    if (_isDisposed) return;
    _player.setVolume(v * 100.0);
  }

  void setPlaybackRate(double r) {
    _playbackRate = r;
    _player.setRate(r);
    _safeNotify();
  }

  void toggleLoopMode() {
    final mode = _player.state.playlistMode;
    final nextMode = mode == PlaylistMode.none ? PlaylistMode.loop : (mode == PlaylistMode.loop ? PlaylistMode.single : PlaylistMode.none);
    _player.setPlaylistMode(nextMode);
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

      await _player.open(Media(result['url']), play: true);
      _player.setRate(_playbackRate);
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
    final quality = settings['audioQuality'] ?? 'flac';
    final result = await MusicApi.getSongUrl(song.hash, quality: quality);
    if (result != null && result['url'] != null) return {'url': result['url']};
    final backup = await MusicApi.getSongUrl(song.hash);
    return (backup != null && backup['url'] != null) ? {'url': backup['url']} : null;
  }

  void togglePlay() => _player.playOrPause();
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
        _player.stop();
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
    // IMPORTANT: Cancel subscriptions FIRST to prevent any pending callbacks
    _cancelSubscriptions();
    _userVolumeController.close();
    // DO NOT call any Player methods (stop, dispose, etc.)
    // The global player instance survives hot restarts
    super.dispose();
  }
}
