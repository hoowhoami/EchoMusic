import 'dart:convert';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../models/song.dart';

class PersistenceProvider with ChangeNotifier {
  static const String _keyFavorites = 'favorites';
  static const String _keyHistory = 'history';
  static const String _keyVolume = 'volume';
  static const String _keyDevice = 'device_info';
  static const String _keyUserInfo = 'user_info';
  static const String _keySettings = 'app_settings';
  static const String _keyPlaylist = 'current_playlist';
  static const String _keyCurrentIndex = 'current_index';
  static const String _keyCurrentPosition = 'current_position';

  List<Song> _favorites = [];
  List<Song> _history = [];
  List<Song> _playlist = [];
  int _currentIndex = -1;
  double _currentPosition = 0;
  double _volume = 1.0;
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
    'playMode': 'repeat',
  };

  List<Song> get favorites => _favorites;
  List<Song> get history => _history;
  List<Song> get playlist => _playlist;
  int get currentIndex => _currentIndex;
  double get currentPosition => _currentPosition;
  double get volume => _volume;
  Map<String, dynamic>? get device => _device;
  Map<String, dynamic>? get userInfo => _userInfo;
  Map<String, dynamic> get settings => _settings;

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

    // Load Index & Position
    _currentIndex = prefs.getInt(_keyCurrentIndex) ?? -1;
    _currentPosition = prefs.getDouble(_keyCurrentPosition) ?? 0.0;
    
    // Load volume
    _volume = prefs.getDouble(_keyVolume) ?? 1.0;

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

  Future<void> savePlaybackState(List<Song> playlist, int index, double position) async {
    _playlist = playlist;
    _currentIndex = index;
    _currentPosition = position;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setStringList(_keyPlaylist, playlist.map((s) => jsonEncode(_songToMap(s))).toList());
    await prefs.setInt(_keyCurrentIndex, index);
    await prefs.setDouble(_keyCurrentPosition, position);
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
    _currentPosition = 0;
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
      'playMode': 'repeat',
    };
    notifyListeners();
  }

  Future<void> toggleFavorite(Song song, {dynamic userProvider}) async {
    final index = _favorites.indexWhere((s) => s.hash == song.hash);
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
    return _favorites.any((s) => s.hash == song.hash);
  }

  Future<void> addToHistory(Song song) async {
    _history.removeWhere((s) => s.hash == song.hash);
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

  Future<void> saveVolume(double volume) async {
    _volume = volume;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setDouble(_keyVolume, volume);
  }

  Future<void> updateSetting(String key, dynamic value) async {
    _settings[key] = value;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_keySettings, jsonEncode(_settings));
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
