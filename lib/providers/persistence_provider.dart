import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../models/song.dart';

class PersistenceProvider with ChangeNotifier {
  static const String _keyFavorites = 'favorites';
  static const String _keyHistory = 'history';
  static const String _keyDevice = 'device_info';
  static const String _keyUserInfo = 'user_info';
  static const String _keySettings = 'app_settings';
  static const String _keyPlayerSettings = 'player_settings';
  static const String _keyPlaylist = 'current_playlist';
  static const String _keyCurrentIndex = 'current_index';

  List<Song> _favorites = [];
  List<Song> _history = [];
  List<Song> _playlist = [];
  int _currentIndex = -1;
  Map<String, dynamic>? _device;
  Map<String, dynamic>? _userInfo;
  Map<String, dynamic> _settings = {
    'theme': 'auto',
    'volumeFade': true,
    'volumeFadeTime': 1000,
    'autoNext': true,
    'autoNextTime': 3000,
    'showPlaylistCount': true,
    'addSongsToPlaylist': true,
    'replacePlaylist': false,
    'preventSleep': true,
    'compatibilityMode': true,
    'backupQuality': '128',
    'audioQuality': 'flac',
    'audioEffect': 'none',
    'autoSign': false,
    'autoReceiveVip': false,
    'userAgreementAccepted': false,
  };
  Map<String, dynamic> _playerSettings = {
    'volume': 0.5,
    'playMode': 'repeat',
    'audioQuality': 'flac',
    'audioEffect': 'none',
  };

  List<Song> get favorites => _favorites;
  List<Song> get history => _history;
  List<Song> get playlist => _playlist;
  int get currentIndex => _currentIndex;
  double get volume => _playerSettings['volume'] ?? 0.5;
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
    
    // Load history
    final historyJson = prefs.getStringList(_keyHistory) ?? [];
    _history = historyJson.map((s) => Song.fromJson(jsonDecode(s))).toList();

    // Load Playlist
    final playlistJson = prefs.getStringList(_keyPlaylist) ?? [];
    _playlist = playlistJson.map((s) => Song.fromJson(jsonDecode(s))).toList();

    // Load Index
    _currentIndex = prefs.getInt(_keyCurrentIndex) ?? -1;
    
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

  Future<void> savePlaybackState(List<Song> playlist, int index) async {
    _playlist = playlist;
    _currentIndex = index;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setStringList(_keyPlaylist, playlist.map((s) => jsonEncode(_songToMap(s))).toList());
    await prefs.setInt(_keyCurrentIndex, index);
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

  Future<void> clearAllData() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.clear();
    _favorites = [];
    _history = [];
    _playlist = [];
    _currentIndex = -1;
    _device = null;
    _userInfo = null;
    _settings = {
      'theme': 'auto',
      'volumeFade': true,
      'volumeFadeTime': 1000,
      'autoNext': true,
      'autoNextTime': 3000,
      'showPlaylistCount': true,
      'addSongsToPlaylist': true,
      'replacePlaylist': false,
      'preventSleep': true,
      'compatibilityMode': true,
      'backupQuality': '128',
      'audioQuality': 'flac',
      'audioEffect': 'none',
      'autoSign': false,
      'autoReceiveVip': false,
      'userAgreementAccepted': false,
    };
    _playerSettings = {
      'volume': 0.5,
      'playMode': 'repeat',
      'audioQuality': 'flac',
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
    notifyListeners();

    // Cloud sync if authenticated
    if (userProvider != null && userProvider.isAuthenticated && userProvider.likedPlaylistId != null) {
      if (isAdding) {
        await userProvider.addSongToPlaylist(userProvider.likedPlaylistId!, song);
      } else {
        await userProvider.removeSongFromPlaylist(userProvider.likedPlaylistId!, song);
      }
    }
  }

  bool isFavorite(Song song) {
    return _favorites.any((s) => s.isSameSong(song));
  }

  Future<void> syncCloudFavorites(List<Song> cloudSongs) async {
    bool changed = false;
    for (var cloudSong in cloudSongs) {
      if (!_favorites.any((s) => s.isSameSong(cloudSong))) {
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
    return {
      'hash': song.hash,
      'name': song.name,
      'albuminfo': {'name': song.albumName},
      'singerinfo': song.singers.map((s) => {'id': s.id, 'name': s.name, 'avatar': s.avatar}).toList(),
      'timelen': song.duration * 1000,
      'cover': song.cover,
      'mixsongid': song.mixSongId,
      'mvhash': song.mvHash,
    };
  }
}
