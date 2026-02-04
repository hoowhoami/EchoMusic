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

  List<Song> _favorites = [];
  List<Song> _history = [];
  double _volume = 1.0;
  Map<String, dynamic>? _device;
  Map<String, dynamic>? _userInfo;

  List<Song> get favorites => _favorites;
  List<Song> get history => _history;
  double get volume => _volume;
  Map<String, dynamic>? get device => _device;
  Map<String, dynamic>? get userInfo => _userInfo;

  PersistenceProvider() {
    _loadData();
  }

  Future<void> _loadData() async {
    final prefs = await SharedPreferences.getInstance();
    
    // Load favorites
    final favsJson = prefs.getStringList(_keyFavorites) ?? [];
    _favorites = favsJson.map((s) => Song.fromJson(jsonDecode(s))).toList();
    
    // Load history
    final historyJson = prefs.getStringList(_keyHistory) ?? [];
    _history = historyJson.map((s) => Song.fromJson(jsonDecode(s))).toList();
    
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

  Future<void> toggleFavorite(Song song) async {
    final index = _favorites.indexWhere((s) => s.hash == song.hash);
    if (index >= 0) {
      _favorites.removeAt(index);
    } else {
      _favorites.insert(0, song);
    }
    
    final prefs = await SharedPreferences.getInstance();
    await prefs.setStringList(
      _keyFavorites,
      _favorites.map((s) => jsonEncode(_songToMap(s))).toList(),
    );
    notifyListeners();
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