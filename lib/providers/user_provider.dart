import 'package:flutter/material.dart';
import '../models/user.dart';
import '../api/music_api.dart';
import 'persistence_provider.dart';
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

  bool _isTvipClaimedToday = false;
  bool _isSvipClaimedToday = false;

  bool get isTvipClaimedToday => _isTvipClaimedToday;
  bool get isSvipClaimedToday => _isSvipClaimedToday;

  Future<void> fetchAllUserData() async {
    if (!isAuthenticated) return;
    
    await Future.wait([
      fetchUserPlaylists(),
      fetchUserFollows(),
      fetchUserHistory(),
      fetchUserCloud(),
      fetchUserDetails(),
      syncVipStatus(),
    ]);
  }

  Future<void> syncVipStatus() async {
    final record = await MusicApi.getVipMonthRecord();
    final today = DateTime.now().toIso8601String().split('T')[0];
    final List list = record['list'] ?? [];
    
    _isTvipClaimedToday = list.any((item) => item['day'] == today);
    // Note: The API doesn't seem to have a direct way to check SVIP upgrade for today other than attempting it or checking the privilege level
    // In Legacy it uses a local state saved in the store, but here we'll just check the record for TVIP.
    notifyListeners();
  }

  Future<bool> claimTvip() async {
    final today = DateTime.now().toIso8601String().split('T')[0];
    final success = await MusicApi.claimDayVip(today);
    if (success) {
      _isTvipClaimedToday = true;
      await fetchUserDetails(); // Refresh VIP info
      notifyListeners();
    }
    return success;
  }

  Future<bool> upgradeSvip() async {
    if (!_isTvipClaimedToday) return false;
    final success = await MusicApi.upgradeDayVip();
    if (success) {
      _isSvipClaimedToday = true;
      await fetchUserDetails(); // Refresh VIP info
      notifyListeners();
    }
    return success;
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
    return _userFollows.any((f) => (f['singerid'] ?? f['author_id']) == id);
  }

  Future<bool> addSongToPlaylist(int listId, Song song) async {
    final songData = "${song.name}|${song.hash}|${song.albumId ?? 0}|${song.mixSongId}";
    final success = await MusicApi.addPlaylistTrack(listId, songData);
    if (success) {
      await fetchUserPlaylists();
    }
    return success;
  }

  Future<int> addSongsToPlaylist(int listId, List<Song> songs) async {
    int successCount = 0;
    // The API doesn't seem to support batch add in one call based on Legacy code (it uses a loop or single call with comma-separated data if supported, but Legacy loops)
    // Actually, MusicApi.addPlaylistTrack takes a 'data' parameter.
    // Legacy code: const songData = `${props.song.name}|${props.song.hash}|${props.song.album_id}|${props.song.mixsongid}`;
    // Let's try batching with comma if the server supports it, or just loop for now.
    for (final song in songs) {
      final success = await addSongToPlaylist(listId, song);
      if (success) successCount++;
    }
    return successCount;
  }

  Future<bool> removeSongFromPlaylist(int listId, Song song) async {
    final fileId = song.fileId ?? song.mixSongId;
    final success = await MusicApi.deletePlaylistTrack(listId, fileId.toString());
    if (success) {
      await fetchUserPlaylists();
    }
    return success;
  }

  bool isCreatedPlaylist(dynamic listId) {
    final id = listId.toString();
    return _userPlaylists.any((p) => (p['listid'] ?? p['specialid']).toString() == id && p['list_create_userid'] == _user?.userid);
  }
}
