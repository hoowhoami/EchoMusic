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
  static const String _keyPlaylistFilteredInvalidSongCount = 'current_playlist_filtered_invalid_song_count';

  List<Song> _favorites = [];
  Set<String> _favoriteHashes = {}; // lowercase hash → O(1) isFavorite lookup
  Set<int> _favoriteMixIds = {};    // non-zero mixSongId → O(1) isFavorite lookup
  List<Song> _history = [];
  List<Song> _playlist = [];
  int _currentIndex = -1;
  int _playlistFilteredInvalidSongCount = 0;
  Map<String, dynamic>? _device;
  Map<String, dynamic>? _userInfo;
  Map<String, dynamic> _settings = {
    'theme': 'auto',
    'volumeFade': true,
    'volumeFadeTime': 1000,
    'autoNext': false,
    'autoNextTime': 3000,
    'showPlaylistCount': true,
    'addSongsToPlaylist': true,
    'replacePlaylist': false,
    'preventSleep': true,
    'compatibilityMode': true,
    'audioQuality': AudioQuality.defaultValue,
    'audioEffect': 'none',
    'autoSign': false,
    'autoReceiveVip': false,
    'userAgreementAccepted': false,
    'lyricOffset': 0,
    'closeBehavior': 'tray',
    'pauseOnDeviceChange': false,
  };
  Map<String, dynamic> _playerSettings = {
    'volume': 50.0,
    'playMode': 'repeat',
    'audioQuality': AudioQuality.defaultValue,
    'audioEffect': 'none',
  };

  List<Song> get favorites => _favorites;
  List<Song> get history => _history;
  List<Song> get playlist => _playlist;
  int get currentIndex => _currentIndex;
  int get playlistFilteredInvalidSongCount => _playlistFilteredInvalidSongCount;
  double get volume => _playerSettings['volume'] ?? 50.0;
  Map<String, dynamic>? get device => _device;
  Map<String, dynamic>? get userInfo => _userInfo;
  Map<String, dynamic> get settings => _settings;
  Map<String, dynamic> get playerSettings => _playerSettings;

  PersistenceProvider() {
    _loadData();
  }

  Future<void> _loadData() async {
    final prefs = await SharedPreferences.getInstance();
    
    // Load settings
    final settingsJson = prefs.getString(_keySettings);
    if (settingsJson != null) {
      _settings = {..._settings, ...jsonDecode(settingsJson)};
    }
    
    // Load favorites
    final favsJson = prefs.getStringList(_keyFavorites) ?? [];
    _favorites = favsJson.map((s) => Song.fromJson(jsonDecode(s))).toList();
    _rebuildFavoriteIndex();
    
    // Load history
    final historyJson = prefs.getStringList(_keyHistory) ?? [];
    _history = historyJson.map((s) => Song.fromJson(jsonDecode(s))).toList();

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
    await prefs.setStringList(_keyPlaylist, playlist.map((s) => jsonEncode(_songToMap(s))).toList());
    await prefs.setInt(_keyCurrentIndex, index);
    await prefs.setInt(_keyPlaylistFilteredInvalidSongCount, filteredInvalidSongCount);
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
    _playlist = [];
    _currentIndex = -1;
    _playlistFilteredInvalidSongCount = 0;
    
    final prefs = await SharedPreferences.getInstance();
    await Future.wait([
      prefs.remove(_keyUserInfo),
      prefs.remove(_keyFavorites),
      prefs.remove(_keyHistory),
      prefs.remove(_keyPlaylist),
      prefs.remove(_keyCurrentIndex),
      prefs.remove(_keyPlaylistFilteredInvalidSongCount),
    ]);
    
    notifyListeners();
  }

  Future<void> clearAllData() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.clear();
    _favorites = [];
    _favoriteHashes = {};
    _favoriteMixIds = {};
    _history = [];
    _playlist = [];
    _currentIndex = -1;
    _playlistFilteredInvalidSongCount = 0;
    _device = null;
    _userInfo = null;
    _settings = {
      'theme': 'auto',
      'volumeFade': true,
      'volumeFadeTime': 1000,
      'autoNext': false,
      'autoNextTime': 3000,
      'showPlaylistCount': true,
      'addSongsToPlaylist': true,
      'replacePlaylist': false,
      'preventSleep': true,
      'compatibilityMode': true,
      'audioQuality': AudioQuality.defaultValue,
      'audioEffect': 'none',
      'autoSign': false,
      'autoReceiveVip': false,
      'userAgreementAccepted': false,
      'closeBehavior': 'tray',
      'pauseOnDeviceChange': false,
    };
    _playerSettings = {
      'volume': 50.0,
      'playMode': 'repeat',
      'audioQuality': AudioQuality.defaultValue,
      'audioEffect': 'none',
    };
    notifyListeners();
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
    if (userProvider != null && userProvider.isAuthenticated && userProvider.likedPlaylistId != null) {
      if (isAdding) {
        await userProvider.addSongToPlaylist(userProvider.likedPlaylistId!, song);
      } else {
        await userProvider.removeSongFromPlaylist(userProvider.likedPlaylistId!, song);
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
    if (song.mixSongId != 0 && _favoriteMixIds.contains(song.mixSongId)) return true;
    if (song.hash.isNotEmpty && _favoriteHashes.contains(song.hash.toLowerCase())) return true;
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
