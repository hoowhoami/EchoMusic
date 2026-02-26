import 'package:flutter/material.dart';
import '../models/user.dart';
import '../api/music_api.dart';
import 'persistence_provider.dart';
import 'refresh_provider.dart';
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
  int _cloudCount = 0;
  int _cloudCapacity = 0;
  int _cloudAvailable = 0;
  List<Song> _likedSongs = [];

  dynamic _likedPlaylistId;
  bool _isInitialSynced = false;
  final ValueNotifier<int> playlistSongsChangeNotifier = ValueNotifier<int>(0);
  RefreshProvider? _refreshProvider;

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
  dynamic get likedPlaylistId => _likedPlaylistId ?? _user?.extendsInfo?['likedPlaylistId'];
  
  List<Map<String, dynamic>> get userPlaylists => _userPlaylists;
  List<Map<String, dynamic>> get userFollows => _userFollows;
  List<Song> get userHistory => _userHistory;
  List<Song> get userCloud => _userCloud;
  int get cloudCount => _cloudCount;
  int get cloudCapacity => _cloudCapacity;
  int get cloudAvailable => _cloudAvailable;
  List<Song> get likedSongs => _likedSongs;

  List<Map<String, dynamic>> get createdPlaylists =>
      _userPlaylists.where((p) => p['list_create_userid'] == _user?.userid).toList();

  List<Map<String, dynamic>> get favoritedPlaylists =>
      _userPlaylists.where((p) => p['list_create_userid'] != _user?.userid).toList();

  List<Map<String, dynamic>> get favoritedOnlyPlaylists =>
      favoritedPlaylists.where((p) => p['source'] != 2).toList();

  List<Map<String, dynamic>> get favoritedAlbums =>
      favoritedPlaylists.where((p) => p['source'] == 2).toList();

  void setPersistenceProvider(PersistenceProvider provider) {
    _persistenceProvider = provider;
    if (provider.userInfo != null) {
      final newUser = User.fromJson(provider.userInfo!);
      if (_user?.userid != newUser.userid) {
        _user = newUser;
        _likedPlaylistId = _user?.extendsInfo?['likedPlaylistId'];
        _isInitialSynced = false;
      }
      
      if (!_isInitialSynced && isAuthenticated) {
        _isInitialSynced = true;
        // Background sync
        fetchAllUserData();
      }
    }
  }

  void setRefreshProvider(RefreshProvider provider) {
    if (_refreshProvider != provider) {
      _refreshProvider?.removeListener(fetchAllUserData);
      _refreshProvider = provider;
      _refreshProvider?.addListener(fetchAllUserData);
    }
  }

  @override
  void dispose() {
    _refreshProvider?.removeListener(fetchAllUserData);
    playlistSongsChangeNotifier.dispose();
    super.dispose();
  }

  void _updatePlaylistSongCount(dynamic listId, int delta) {
    final index = _userPlaylists.indexWhere((p) {
      final id = (p['listid'] ?? p['specialid'] ?? p['list_create_gid'] ?? p['gid'])?.toString();
      return id == listId?.toString();
    });
    if (index != -1) {
      final p = Map<String, dynamic>.from(_userPlaylists[index]);
      p['song_count'] = (p['song_count'] ?? 0) + delta;
      p['count'] = (p['count'] ?? 0) + delta;
      _userPlaylists[index] = p;
      notifyListeners();
    }
  }

  void notifyPlaylistSongsChanged(dynamic listId) {
    // Convert to int if possible, otherwise use hash as a notifier value
    int notifyValue = 0;
    if (listId is int) {
      notifyValue = listId;
    } else if (listId != null) {
      notifyValue = listId.toString().hashCode.abs();
    }
    playlistSongsChangeNotifier.value = notifyValue;
    // Reset so that the same playlist can trigger again if needed
    Future.delayed(const Duration(milliseconds: 100), () {
      playlistSongsChangeNotifier.value = 0;
    });
  }

  /// Helper to get the correct numeric listid from any ID (GID or local)
  dynamic _getNumericListId(dynamic id) {
    if (id == null) return 0;
    final idStr = id.toString();
    
    // Find the playlist in our local list to get its numeric ID
    final index = _userPlaylists.indexWhere((p) {
      return (p['listid'] ?? p['specialid'])?.toString() == idStr || 
             (p['list_create_gid'] ?? p['gid'])?.toString() == idStr;
    });

    if (index != -1) {
      final p = _userPlaylists[index];
      return p['listid'] ?? p['specialid'] ?? id;
    }
    
    return id;
  }

  Future<void> fetchLikedSongs({int? listid, String? gid}) async {
    final targetGid = gid ?? (likedPlaylistId is String ? likedPlaylistId : null);
    final targetListid = listid ?? (likedPlaylistId is int ? likedPlaylistId : null);
    
    if (targetGid == null && targetListid == null) {
      return;
    }

    List<Song> songs = [];
    
    // STRATEGY 1: Use GID with the standard track/all API (Most reliable for cloud sync)
    if (targetGid != null) {
      songs = await MusicApi.getPlaylistSongs(targetGid);
    }
    
    // STRATEGY 2: Fallback to Numeric ID with track/all/new if GID failed
    if (songs.isEmpty && targetListid != null) {
      final response = await MusicApi.getPlaylistTrackAllNew(targetListid, pagesize: 500);
      songs = MusicApi.parseSongsFromResponse(response);
    }

    if (songs.isNotEmpty) {
      _likedSongs = songs;
      if (_persistenceProvider != null) {
        _persistenceProvider!.syncCloudFavorites(_likedSongs);
      }
      notifyListeners();
    }
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
    _likedSongs = [];
    await _persistenceProvider?.clearUserInfo();
    _userPlaylists = [];
    _userFollows = [];
    _userHistory = [];
    _userCloud = [];
    _cloudCount = 0;
    _cloudCapacity = 0;
    _cloudAvailable = 0;
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
    
    // Check if user is currently an SVIP
    final vipInfo = _user?.extendsInfo?['vip'] ?? {};
    final busiVip = vipInfo['busi_vip'] as List? ?? [];
    final hasActiveSvip = busiVip.any((v) => v['product_type'] == 'svip' && v['is_vip'] == 1);
    
    if (hasActiveSvip) {
      _isSvipClaimedToday = true;
    }

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
    final response = await MusicApi.getUserPlaylistsRaw(pagesize: 100);
    if (response['status'] == 1) {
      List data = response['info'] ?? response['data']?['info'] ?? [];
      _userPlaylists = data.cast<Map<String, dynamic>>();
      
      // Identify "I Like" playlist with NEW PRIORITY
      int likedIndex = _userPlaylists.indexWhere((p) {
        final name = p['name']?.toString() ?? '';
        return name == '我喜欢' || name == '我喜欢的音乐';
      });

      if (likedIndex == -1) {
        likedIndex = _userPlaylists.indexWhere((p) => p['name']?.toString().contains('喜欢') ?? false);
      }

      if (likedIndex == -1) {
        likedIndex = _userPlaylists.indexWhere((p) => p['type'] == 1 || p['is_def'] == 1 || p['is_default'] == 1 || p['is_def'] == 2);
      }

      if (likedIndex == -1) {
        likedIndex = _userPlaylists.indexWhere((p) => p['name']?.toString() == '默认收藏');
      }
      
      if (likedIndex != -1) {
        final liked = _userPlaylists[likedIndex];
        // STRATEGY: Always prefer GID for storage to avoid numeric ID issues
        _likedPlaylistId = liked['list_create_gid'] ?? liked['gid'] ?? liked['listid'];
        
        // Persist
        if (_user != null && _user?.extendsInfo?['likedPlaylistId'] != _likedPlaylistId) {
          _user = _user!.copyWith(
            extendsInfo: {..._user!.extendsInfo ?? {}, 'likedPlaylistId': _likedPlaylistId},
          );
          await _persistenceProvider?.setUserInfo(_user!.toJson());
        }

        // Fetch songs
        fetchLikedSongs(
          listid: int.tryParse(liked['listid']?.toString() ?? ''),
          gid: liked['list_create_gid']?.toString(),
        );
      }
      
      notifyListeners();
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
    List<Song> allSongs = [];
    int page = 1;
    const int pageSize = 100; 
    
    try {
      // First fetch to get count and first batch
      final res = await MusicApi.getUserCloud(page: page, pagesize: pageSize);
      allSongs.addAll(res['songs'] ?? []);
      _cloudCount = res['count'] ?? 0;
      _cloudCapacity = res['capacity'] ?? 0;
      _cloudAvailable = res['available'] ?? 0;
      
      // Fetch remaining pages if any
      while (allSongs.length < _cloudCount) {
        page++;
        final nextRes = await MusicApi.getUserCloud(page: page, pagesize: pageSize);
        final List<Song> nextSongs = nextRes['songs'] ?? [];
        if (nextSongs.isEmpty) break;
        allSongs.addAll(nextSongs);
      }
      
      _userCloud = allSongs;
    } catch (e) {
      debugPrint('Error fetching cloud songs: $e');
    }
    
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
      
      // Update SVIP claimed status based on actual VIP info
      final busiVip = vip['busi_vip'] as List? ?? [];
      final hasActiveSvip = busiVip.any((v) => v['product_type'] == 'svip' && v['is_vip'] == 1);
      if (hasActiveSvip) {
        _isSvipClaimedToday = true;
      }
      
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

  Future<bool> favoriteAlbum(int albumId, String name, {int? singerId}) async {
    final success = await MusicApi.copyPlaylist(
      albumId, 
      name, 
      listCreateUserid: singerId,
      listCreateListid: albumId,
      source: 2, // Source 2 for albums
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

  Future<bool> unfavoriteAlbum(int albumId) async {
    return unfavoritePlaylist(albumId);
  }

  Future<bool> addSongToPlaylist(dynamic listId, Song song) async {
    final numericId = _getNumericListId(listId);
    final songData = "${song.name}|${song.hash}|${song.albumId ?? 0}|${song.mixSongId}";
    final success = await MusicApi.addPlaylistTrack(numericId, songData);
    if (success) {
      if (listId?.toString() == likedPlaylistId?.toString()) {
        if (!_likedSongs.any((s) => s.isSameSong(song))) {
          _likedSongs.insert(0, song);
        }
        _persistenceProvider?.syncCloudFavorites([song]);
      }
      _updatePlaylistSongCount(listId, 1);
      notifyPlaylistSongsChanged(listId);
    }
    return success;
  }

  Future<int> addSongsToPlaylist(dynamic listId, List<Song> songs) async {
    if (songs.isEmpty) return 0;
    
    final numericId = _getNumericListId(listId);
    // Legacy API supports batch adding by comma-separated song data
    final data = songs.map((s) => "${s.name}|${s.hash}|${s.albumId ?? 0}|${s.mixSongId}").join(',');
    final success = await MusicApi.addPlaylistTrack(numericId, data);
    
    if (success) {
      if (listId?.toString() == likedPlaylistId?.toString()) {
        for (var song in songs) {
          if (!_likedSongs.any((s) => s.isSameSong(song))) {
            _likedSongs.insert(0, song);
          }
        }
        _persistenceProvider?.syncCloudFavorites(songs);
      }
      _updatePlaylistSongCount(listId, songs.length);
      notifyPlaylistSongsChanged(listId);
      return songs.length;
    }
    return 0;
  }

  Future<bool> removeSongFromPlaylist(dynamic listId, Song song) async {
    final numericId = _getNumericListId(listId);
    final fileId = song.fileId ?? song.mixSongId;
    final success = await MusicApi.deletePlaylistTrack(numericId, fileId.toString());
    if (success) {
      if (listId?.toString() == likedPlaylistId?.toString()) {
        _likedSongs.removeWhere((s) => s.isSameSong(song));
        _persistenceProvider?.removeFromFavorites(song);
      }
      _updatePlaylistSongCount(listId, -1);
      notifyPlaylistSongsChanged(listId);
    }
    return success;
  }

  Future<int> removeSongsFromPlaylist(dynamic listId, List<Song> songs) async {
    final numericId = _getNumericListId(listId);
    final fileIds = songs.map((s) => s.fileId ?? s.mixSongId).join(',');
    final success = await MusicApi.deletePlaylistTrack(numericId, fileIds);
    if (success) {
      if (listId?.toString() == likedPlaylistId?.toString()) {
        for (var song in songs) {
          _likedSongs.removeWhere((s) => s.isSameSong(song));
          _persistenceProvider?.removeFromFavorites(song);
        }
      }
      _updatePlaylistSongCount(listId, -songs.length);
      notifyPlaylistSongsChanged(listId);
      return songs.length;
    }
    return 0;
  }

  bool isCreatedPlaylist(dynamic listId) {
    final id = listId.toString();
    return _userPlaylists.any((p) => (p['listid'] ?? p['specialid'] ?? p['list_create_gid'] ?? p['gid']).toString() == id && p['list_create_userid'] == _user?.userid);
  }
}
