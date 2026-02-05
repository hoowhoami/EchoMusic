import 'package:flutter/material.dart';
import '../models/user.dart';
import '../api/music_api.dart';
import 'persistence_provider.dart';
import '../models/playlist.dart';
import '../models/song.dart';

class UserProvider with ChangeNotifier {
  User? _user;
  PersistenceProvider? _persistenceProvider;
  
  List<Map<String, dynamic>> _userPlaylists = [];
  List<Map<String, dynamic>> _userFollows = [];
  List<Song> _userHistory = [];
  List<Song> _userCloud = [];

  User? get user => _user;
  bool get isAuthenticated => _user != null && _user!.token.isNotEmpty;
  
  List<Map<String, dynamic>> get userPlaylists => _userPlaylists;
  List<Map<String, dynamic>> get userFollows => _userFollows;
  List<Song> get userHistory => _userHistory;
  List<Song> get userCloud => _userCloud;

  void setPersistenceProvider(PersistenceProvider provider) {
    _persistenceProvider = provider;
    if (provider.userInfo != null) {
      _user = User.fromJson(provider.userInfo!);
    }
  }

  Future<void> login(String mobile, String code) async {
    final userData = await MusicApi.loginCellphone(mobile, code);
    if (userData != null) {
      _user = User.fromJson(userData);
      await _persistenceProvider?.setUserInfo(userData);
      await fetchAllUserData();
      notifyListeners();
    }
  }

  Future<void> handleQrLoginSuccess(Map<String, dynamic> userData) async {
    _user = User.fromJson(userData);
    await _persistenceProvider?.setUserInfo(userData);
    await fetchAllUserData();
    notifyListeners();
  }

  Future<void> logout() async {
    _user = null;
    await _persistenceProvider?.setUserInfo({});
    _userPlaylists = [];
    _userFollows = [];
    _userHistory = [];
    _userCloud = [];
    notifyListeners();
  }

  Future<void> fetchAllUserData() async {
    if (!isAuthenticated) return;
    
    await Future.wait([
      fetchUserPlaylists(),
      fetchUserFollows(),
      fetchUserHistory(),
      fetchUserCloud(),
      fetchUserDetails(),
    ]);
  }

  Future<void> fetchUserPlaylists() async {
    _userPlaylists = await MusicApi.getUserPlaylists();
    notifyListeners();
  }

  Future<void> fetchUserFollows() async {
    _userFollows = await MusicApi.getUserFollow();
    notifyListeners();
  }

  Future<void> fetchUserHistory() async {
    _userHistory = await MusicApi.getUserPlayHistory();
    notifyListeners();
  }

  Future<void> fetchUserCloud() async {
    _userCloud = await MusicApi.getUserCloud();
    notifyListeners();
  }

  Future<void> fetchUserDetails() async {
    final details = await MusicApi.userDetail();
    if (details != null && _user != null) {
      _user = _user!.copyWith(
        username: details['username']?.toString(),
        nickname: details['nickname']?.toString(),
        pic: details['pic']?.toString(),
        extendsInfo: {
          ..._user!.extendsInfo ?? {},
          'detail': details,
        },
      );
      await _persistenceProvider?.setUserInfo(_user!.toJson());
      notifyListeners();
    }
    
    final vip = await MusicApi.userVipDetail();
    if (vip != null && _user != null) {
      _user = _user!.copyWith(
        extendsInfo: {
          ..._user!.extendsInfo ?? {},
          'vip': vip,
        },
      );
      await _persistenceProvider?.setUserInfo(_user!.toJson());
      notifyListeners();
    }
  }

  Future<bool> followSinger(int id) async {
    final success = await MusicApi.followSinger(id);
    if (success) {
      await fetchUserFollows();
    }
    return success;
  }

  Future<bool> unfollowSinger(int id) async {
    final success = await MusicApi.unfollowSinger(id);
    if (success) {
      await fetchUserFollows();
    }
    return success;
  }

  bool isFollowingSinger(int id) {
    return _userFollows.any((f) => f['singerid'] == id);
  }
}
