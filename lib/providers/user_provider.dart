import 'package:flutter/material.dart';
import '../models/user.dart';
import '../api/music_api.dart';
import 'persistence_provider.dart';
import '../models/song.dart';

class UserProvider with ChangeNotifier {
  User? _user;
  PersistenceProvider? _persistenceProvider;
  VoidCallback? onSessionExpired;
  Function(String)? onPlaylistError;
  
  List<Map<String, dynamic>> _userPlaylists = [];
  List<Map<String, dynamic>> _userFollows = [];
  List<Song> _userHistory = [];
  List<Song> _userCloud = [];

  int? _likedPlaylistId;
  final ValueNotifier<int> playlistSongsChangeNotifier = ValueNotifier<int>(0);

  UserProvider() {
    MusicApi.onAuthExpired = () {
      if (isAuthenticated) {
        logout();
        onSessionExpired?.call();
      }
    };
  }

  User? get user => _user;
  bool get isAuthenticated => _user != null && _user!.token.isNotEmpty;
  int? get likedPlaylistId => _likedPlaylistId ?? _user?.extendsInfo?['likedPlaylistId'];
  
  List<Map<String, dynamic>> get userPlaylists => _userPlaylists;
  List<Map<String, dynamic>> get userFollows => _userFollows;
  List<Song> get userHistory => _userHistory;
  List<Song> get userCloud => _userCloud;

  List<Map<String, dynamic>> get createdPlaylists =>
      _userPlaylists.where((p) => p['list_create_userid'] == _user?.userid).toList();

  List<Map<String, dynamic>> get favoritedPlaylists =>
      _userPlaylists.where((p) => p['list_create_userid'] != _user?.userid).toList();

  void setPersistenceProvider(PersistenceProvider provider) {
    _persistenceProvider = provider;
    if (provider.userInfo != null) {
      _user = User.fromJson(provider.userInfo!);
      _likedPlaylistId = _user?.extendsInfo?['likedPlaylistId'];
    }
  }

  void _updatePlaylistSongCount(int listId, int delta) {
    final index = _userPlaylists.indexWhere((p) => (p['listid'] ?? p['specialid']) == listId);
    if (index != -1) {
      final p = Map<String, dynamic>.from(_userPlaylists[index]);
      p['song_count'] = (p['song_count'] ?? 0) + delta;
      p['count'] = (p['count'] ?? 0) + delta;
      _userPlaylists[index] = p;
      notifyListeners();
    }
  }

  void notifyPlaylistSongsChanged(int listId) {
    playlistSongsChangeNotifier.value = listId;
    // Reset so that the same playlist can trigger again if needed
    Future.delayed(const Duration(milliseconds: 100), () {
      playlistSongsChangeNotifier.value = 0;
    });
  }

  Future<Map<String, dynamic>> login(String mobile, String code, {int? userid}) async {
    final response = await MusicApi.loginCellphone(mobile, code, userid: userid);
    if (response['status'] == 1 && response['data'] != null) {
      final userData = response['data'];
      _user = User.fromJson(userData);
      await _persistenceProvider?.setUserInfo(userData);
      await fetchAllUserData();
      notifyListeners();
    }
    return response;
  }

  Future<void> handleQrLoginSuccess(Map<String, dynamic> userData) async {
    _user = User.fromJson(userData);
    await _persistenceProvider?.setUserInfo(userData);
    await fetchAllUserData();
    notifyListeners();
  }

  Future<void> logout() async {
    _user = null;
    _likedPlaylistId = null;
    await _persistenceProvider?.clearUserInfo();
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
    final response = await MusicApi.getUserPlaylistsRaw();
    if (response['status'] == 1) {
      // Correct the path: info is often at the root of response
      List data = response['info'] ?? response['data']?['info'] ?? [];
      _userPlaylists = data.cast<Map<String, dynamic>>();
      
      // Identify "I Like" playlist
      final likedIndex = _userPlaylists.indexWhere(
        (p) => p['list_create_userid'] == _user?.userid && 
               (p['name'] == '我喜欢' || p['name'] == '默认收藏'),
      );
      
      if (likedIndex != -1) {
        final liked = _userPlaylists[likedIndex];
        _likedPlaylistId = liked['listid'] ?? liked['specialid'];
        
        // Persist it in user info
        if (_user != null && _user?.extendsInfo?['likedPlaylistId'] != _likedPlaylistId) {
          _user = _user!.copyWith(
            extendsInfo: {
              ..._user!.extendsInfo ?? {},
              'likedPlaylistId': _likedPlaylistId,
            },
          );
          await _persistenceProvider?.setUserInfo(_user!.toJson());
        }
      }
      
      notifyListeners();
    } else if (response['status'] == 0) {
      onPlaylistError?.call('新账号请先在酷狗官方客户端登录一次');
    }
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

  bool isPlaylistFavorited(dynamic playlistId, {String? globalId}) {
    final id = playlistId.toString();
    final gid = globalId?.toString();
    return _userPlaylists.any((p) {
      final localId = (p['listid'] ?? p['specialid'])?.toString();
      final originalId = p['list_create_gid']?.toString();
      final originalListid = p['list_create_listid']?.toString();
      
      // Match by local ID
      if (localId == id) return true;
      // Match by original GID
      if (gid != null && originalId == gid && originalId != '0') return true;
      if (originalId == id && originalId != '0') return true;
      // Match by original listid
      if (originalListid == id && originalListid != '0') return true;
      
      return false;
    });
  }

  Future<bool> favoritePlaylist(int playlistId, String name, {int? listCreateUserid, String? listCreateGid, int? listCreateListid}) async {
    final success = await MusicApi.copyPlaylist(
      playlistId, 
      name, 
      listCreateUserid: listCreateUserid,
      listCreateGid: listCreateGid,
      listCreateListid: listCreateListid,
    );
    if (success) {
      await fetchUserPlaylists();
    }
    return success;
  }

  Future<bool> unfavoritePlaylist(int playlistId, {String? globalId}) async {
    // Find the local listid for this playlist in the user's collection
    final id = playlistId.toString();
    final gid = globalId?.toString();
    final p = _userPlaylists.firstWhere(
      (p) {
        final localId = (p['listid'] ?? p['specialid'])?.toString();
        final originalId = p['list_create_gid']?.toString();
        final originalListid = p['list_create_listid']?.toString();
        
        if (localId == id) return true;
        if (gid != null && originalId == gid && originalId != '0') return true;
        if (originalId == id && originalId != '0') return true;
        if (originalListid == id && originalListid != '0') return true;
        
        return false;
      },
      orElse: () => {},
    );

    final localListId = p['listid'] ?? p['specialid'];
    if (localListId == null) return false;

    final success = await MusicApi.deletePlaylist(localListId);
    if (success) {
      await fetchUserPlaylists();
    }
    return success;
  }

  Future<bool> addSongToPlaylist(int listId, Song song) async {
    final songData = "${song.name}|${song.hash}|${song.albumId ?? 0}|${song.mixSongId}";
    final success = await MusicApi.addPlaylistTrack(listId, songData);
    if (success) {
      _updatePlaylistSongCount(listId, 1);
      notifyPlaylistSongsChanged(listId);
    }
    return success;
  }

  Future<int> addSongsToPlaylist(int listId, List<Song> songs) async {
    if (songs.isEmpty) return 0;
    
    // Legacy API supports batch adding by comma-separated song data
    final data = songs.map((s) => "${s.name}|${s.hash}|${s.albumId ?? 0}|${s.mixSongId}").join(',');
    final success = await MusicApi.addPlaylistTrack(listId, data);
    
    if (success) {
      _updatePlaylistSongCount(listId, songs.length);
      notifyPlaylistSongsChanged(listId);
      return songs.length;
    }
    return 0;
  }

  Future<bool> removeSongFromPlaylist(int listId, Song song) async {
    final fileId = song.fileId ?? song.mixSongId;
    final success = await MusicApi.deletePlaylistTrack(listId, fileId.toString());
    if (success) {
      _updatePlaylistSongCount(listId, -1);
      notifyPlaylistSongsChanged(listId);
    }
    return success;
  }

  Future<int> removeSongsFromPlaylist(int listId, List<Song> songs) async {
    final fileIds = songs.map((s) => s.fileId ?? s.mixSongId).join(',');
    final success = await MusicApi.deletePlaylistTrack(listId, fileIds);
    if (success) {
      _updatePlaylistSongCount(listId, -songs.length);
      notifyPlaylistSongsChanged(listId);
      return songs.length;
    }
    return 0;
  }

  bool isCreatedPlaylist(dynamic listId) {
    final id = listId.toString();
    return _userPlaylists.any((p) => (p['listid'] ?? p['specialid']).toString() == id && p['list_create_userid'] == _user?.userid);
  }
}
