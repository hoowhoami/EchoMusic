import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../models/song.dart';
import '../utils/constants.dart';

class PersistenceProvider with ChangeNotifier {
  static const String _keyFavorites = 'favorites';
  static const String _keyHistory = 'history';
  static const String _keyDevice = 'device_info';
  static const String _keyUserInfo = 'user_info';
  static const String _keySettings = 'app_settings';
  static const String _keyPlayerSettings = 'player_settings';
  static const String _keyPlaylist = 'current_playlist';
  static const String _keyCurrentIndex = 'current_index';
  static const String _keyPlaylistFilteredInvalidSongCount =
      'current_playlist_filtered_invalid_song_count';
  static const String _keyAudioPlaybackCache = 'audio_playback_cache';
  static const String _keySearchHistory = 'search_history';

  List<Song> _favorites = [];
  Set<String> _favoriteHashes = {}; // lowercase hash → O(1) isFavorite lookup
  Set<int> _favoriteMixIds = {}; // non-zero mixSongId → O(1) isFavorite lookup
  List<Song> _history = [];
  List<String> _searchHistory = [];
  List<Song> _playlist = [];
  int _currentIndex = -1;
  int _playlistFilteredInvalidSongCount = 0;
  Map<String, dynamic>? _device;
  Map<String, dynamic>? _userInfo;
  Map<String, dynamic> _audioPlaybackCache = {};
  bool _isLoaded = false;
  int _dataResetVersion = 0;
  Map<String, dynamic> _settings = {
    'theme': 'auto',
    'volumeFade': true,
    'volumeFadeTime': 1000,
    'autoNext': false,
    'autoNextTime': 3000,
    'showPlaylistCount': true,
    'replacePlaylist': false,
    'preventSleep': true,
    'compatibilityMode': true,
    'audioQuality': AudioQuality.defaultValue,
    'audioEffect': 'none',
    'autoSign': false,
    'autoReceiveVip': false,
    'userAgreementAccepted': false,
    'lyricOffset': 0,
    'lyricFontScale': 1.0,
    'lyricsModePreference': 'none',
    'closeBehavior': 'tray',
    'pauseOnDeviceChange': false,
    'globalShortcutsEnabled': false,
    'audioPlaybackCacheTtlHours': 6,
    'audioPlaybackCacheSize': 1000,
  };
  Map<String, dynamic> _playerSettings = {
    'volume': 50.0,
    'playMode': 'repeat',
    'audioQuality': AudioQuality.defaultValue,
    'audioEffect': 'none',
  };

  List<Song> get favorites => _favorites;
  List<Song> get history => _history;
  List<String> get searchHistory => _searchHistory;
  List<Song> get playlist => _playlist;
  int get currentIndex => _currentIndex;
  int get playlistFilteredInvalidSongCount => _playlistFilteredInvalidSongCount;
  double get volume => _playerSettings['volume'] ?? 50.0;
  Map<String, dynamic>? get device => _device;
  Map<String, dynamic>? get userInfo => _userInfo;
  Map<String, dynamic> get audioPlaybackCache => _audioPlaybackCache;
  bool get isLoaded => _isLoaded;
  Map<String, dynamic> get settings => _settings;
  Map<String, dynamic> get playerSettings => _playerSettings;
  int get dataResetVersion => _dataResetVersion;

  PersistenceProvider() {
    _loadData();
  }

  Future<void> _loadData() async {
    final prefs = await SharedPreferences.getInstance();

    // Load settings
    final settingsJson = prefs.getString(_keySettings);
    if (settingsJson != null) {
      _settings = {..._settings, ...jsonDecode(settingsJson)};
      if (_settings.remove('addSongsToPlaylist') != null) {
        await prefs.setString(_keySettings, jsonEncode(_settings));
      }
    }

    // Load favorites
    final favsJson = prefs.getStringList(_keyFavorites) ?? [];
    _favorites = favsJson.map((s) => Song.fromJson(jsonDecode(s))).toList();
    _rebuildFavoriteIndex();

    // Load history
    final historyJson = prefs.getStringList(_keyHistory) ?? [];
    _history = historyJson.map((s) => Song.fromJson(jsonDecode(s))).toList();

    // Load search history
    _searchHistory = prefs.getStringList(_keySearchHistory) ?? [];

    // Load Playlist
    final playlistJson = prefs.getStringList(_keyPlaylist) ?? [];
    _playlist = playlistJson.map((s) => Song.fromJson(jsonDecode(s))).toList();

    // Load Index
    _currentIndex = prefs.getInt(_keyCurrentIndex) ?? -1;

    // Load current playlist filtered invalid-song count
    _playlistFilteredInvalidSongCount =
        prefs.getInt(_keyPlaylistFilteredInvalidSongCount) ?? 0;

    // Load player settings
    final playerSettingsJson = prefs.getString(_keyPlayerSettings);
    if (playerSettingsJson != null) {
      _playerSettings = {..._playerSettings, ...jsonDecode(playerSettingsJson)};
    }

    // Load playback cache
    final playbackCacheJson = prefs.getString(_keyAudioPlaybackCache);
    if (playbackCacheJson != null) {
      final decoded = jsonDecode(playbackCacheJson);
      if (decoded is Map<String, dynamic>) {
        _audioPlaybackCache = Map<String, dynamic>.from(decoded);
      }
    }

    // Load Device Info
    final deviceJson = prefs.getString(_keyDevice);
    if (deviceJson != null) {
      _device = jsonDecode(deviceJson);
    }

    // Load User Info
    final userJson = prefs.getString(_keyUserInfo);
    if (userJson != null) {
      _userInfo = jsonDecode(userJson);
    }

    _isLoaded = true;
    notifyListeners();
  }

  Future<void> savePlaybackState(
    List<Song> playlist,
    int index, {
    int filteredInvalidSongCount = 0,
  }) async {
    _playlist = playlist;
    _currentIndex = index;
    _playlistFilteredInvalidSongCount = filteredInvalidSongCount;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setStringList(
      _keyPlaylist,
      playlist.map((s) => jsonEncode(_songToMap(s))).toList(),
    );
    await prefs.setInt(_keyCurrentIndex, index);
    await prefs.setInt(
      _keyPlaylistFilteredInvalidSongCount,
      filteredInvalidSongCount,
    );
  }

  Future<void> setDevice(Map<String, dynamic> device) async {
    _device = device;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_keyDevice, jsonEncode(device));
    notifyListeners();
  }

  Future<void> setUserInfo(Map<String, dynamic> userInfo) async {
    _userInfo = userInfo;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_keyUserInfo, jsonEncode(userInfo));
    notifyListeners();
  }

  Future<void> clearUserInfo() async {
    _userInfo = null;
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_keyUserInfo);
    notifyListeners();
  }

  Future<void> clearUserSession() async {
    _userInfo = null;
    _favorites = [];
    _favoriteHashes = {};
    _favoriteMixIds = {};
    _history = [];
    _searchHistory = [];
    _playlist = [];
    _currentIndex = -1;
    _playlistFilteredInvalidSongCount = 0;
    _audioPlaybackCache = {};

    final prefs = await SharedPreferences.getInstance();
    await Future.wait([
      prefs.remove(_keyUserInfo),
      prefs.remove(_keyFavorites),
      prefs.remove(_keyHistory),
      prefs.remove(_keySearchHistory),
      prefs.remove(_keyPlaylist),
      prefs.remove(_keyCurrentIndex),
      prefs.remove(_keyPlaylistFilteredInvalidSongCount),
      prefs.remove(_keyAudioPlaybackCache),
    ]);

    _dataResetVersion++;

    notifyListeners();
  }

  Future<void> clearAllData() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.clear();
    _favorites = [];
    _favoriteHashes = {};
    _favoriteMixIds = {};
    _history = [];
    _searchHistory = [];
    _playlist = [];
    _currentIndex = -1;
    _playlistFilteredInvalidSongCount = 0;
    _device = null;
    _userInfo = null;
    _audioPlaybackCache = {};
    _settings = {
      'theme': 'auto',
      'volumeFade': true,
      'volumeFadeTime': 1000,
      'autoNext': false,
      'autoNextTime': 3000,
      'showPlaylistCount': true,
      'replacePlaylist': false,
      'preventSleep': true,
      'compatibilityMode': true,
      'audioQuality': AudioQuality.defaultValue,
      'audioEffect': 'none',
      'autoSign': false,
      'autoReceiveVip': false,
      'userAgreementAccepted': false,
      'lyricOffset': 0,
      'lyricsModePreference': 'none',
      'closeBehavior': 'tray',
      'pauseOnDeviceChange': false,
      'globalShortcutsEnabled': false,
      'audioPlaybackCacheTtlHours': 6,
      'audioPlaybackCacheSize': 1000,
    };
    _playerSettings = {
      'volume': 50.0,
      'playMode': 'repeat',
      'audioQuality': AudioQuality.defaultValue,
      'audioEffect': 'none',
    };
    _dataResetVersion++;
    notifyListeners();
  }

  Future<void> setAudioPlaybackCache(Map<String, dynamic> cache) async {
    _audioPlaybackCache = cache;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_keyAudioPlaybackCache, jsonEncode(cache));
  }

  Future<void> toggleFavorite(Song song, {dynamic userProvider}) async {
    final index = _favorites.indexWhere((s) => s.isSameSong(song));
    bool isAdding = index < 0;

    if (isAdding) {
      _favorites.insert(0, song);
    } else {
      _favorites.removeAt(index);
    }

    final prefs = await SharedPreferences.getInstance();
    await prefs.setStringList(
      _keyFavorites,
      _favorites.map((s) => jsonEncode(_songToMap(s))).toList(),
    );
    _rebuildFavoriteIndex();
    notifyListeners();
    if (userProvider != null &&
        userProvider.isAuthenticated &&
        userProvider.likedPlaylistId != null) {
      if (isAdding) {
        await userProvider.addSongToPlaylist(
          userProvider.likedPlaylistId!,
          song,
        );
      } else {
        await userProvider.removeSongFromPlaylist(
          userProvider.likedPlaylistId!,
          song,
        );
      }
    }
  }

  void _rebuildFavoriteIndex() {
    _favoriteHashes = _favorites
        .where((s) => s.hash.isNotEmpty)
        .map((s) => s.hash.toLowerCase())
        .toSet();
    _favoriteMixIds = _favorites
        .where((s) => s.mixSongId != 0)
        .map((s) => s.mixSongId)
        .toSet();
  }

  bool isFavorite(Song song) {
    if (song.mixSongId != 0 && _favoriteMixIds.contains(song.mixSongId)) {
      return true;
    }
    if (song.hash.isNotEmpty &&
        _favoriteHashes.contains(song.hash.toLowerCase())) {
      return true;
    }
    return false;
  }

  Future<void> syncCloudFavorites(List<Song> cloudSongs) async {
    bool changed = false;
    for (var cloudSong in cloudSongs) {
      if (!isFavorite(cloudSong)) {
        _favorites.add(cloudSong);
        changed = true;
      }
    }

    if (changed) {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setStringList(
        _keyFavorites,
        _favorites.map((s) => jsonEncode(_songToMap(s))).toList(),
      );
      _rebuildFavoriteIndex();
      notifyListeners();
    }
  }

  Future<void> removeFromFavorites(Song song) async {
    final index = _favorites.indexWhere((s) => s.isSameSong(song));
    if (index != -1) {
      _favorites.removeAt(index);
      final prefs = await SharedPreferences.getInstance();
      await prefs.setStringList(
        _keyFavorites,
        _favorites.map((s) => jsonEncode(_songToMap(s))).toList(),
      );
      _rebuildFavoriteIndex();
      notifyListeners();
    }
  }

  Future<void> addToHistory(Song song) async {
    _history.removeWhere((s) => s.isSameSong(song));
    _history.insert(0, song);

    if (_history.length > 100) {
      _history = _history.sublist(0, 100);
    }

    final prefs = await SharedPreferences.getInstance();
    await prefs.setStringList(
      _keyHistory,
      _history.map((s) => jsonEncode(_songToMap(s))).toList(),
    );
    notifyListeners();
  }

  Future<void> addToSearchHistory(String keyword) async {
    final trimmed = keyword.trim();
    if (trimmed.isEmpty) return;

    _searchHistory.removeWhere((s) => s == trimmed);
    _searchHistory.insert(0, trimmed);

    if (_searchHistory.length > 10) {
      _searchHistory = _searchHistory.sublist(0, 10);
    }

    final prefs = await SharedPreferences.getInstance();
    await prefs.setStringList(_keySearchHistory, _searchHistory);
    notifyListeners();
  }

  Future<void> removeFromSearchHistory(String keyword) async {
    _searchHistory.removeWhere((s) => s == keyword);
    final prefs = await SharedPreferences.getInstance();
    await prefs.setStringList(_keySearchHistory, _searchHistory);
    notifyListeners();
  }

  Future<void> clearSearchHistory() async {
    _searchHistory = [];
    final prefs = await SharedPreferences.getInstance();
    await prefs.remove(_keySearchHistory);
    notifyListeners();
  }

  Future<void> updateSetting(String key, dynamic value) async {
    _settings[key] = value;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_keySettings, jsonEncode(_settings));
    notifyListeners();
  }

  Future<void> updatePlayerSetting(String key, dynamic value) async {
    _playerSettings[key] = value;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_keyPlayerSettings, jsonEncode(_playerSettings));
    notifyListeners();
  }

  Map<String, dynamic> _songToMap(Song song) {
    return song.toJson();
  }
}
