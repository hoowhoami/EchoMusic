import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'backend/music_api_backend.dart';
import 'backend/http_music_api_backend.dart';
import 'music_api_auth.dart';
import 'transport/http_music_transport.dart';
import 'transport/music_transport.dart';
import '../models/song.dart';
import '../models/playlist.dart';
import '../utils/logger.dart';

class PlaylistSongsParseResult {
  final List<Song> songs;
  final int filteredCount;

  const PlaylistSongsParseResult({required this.songs, this.filteredCount = 0});

  int get sourceCount => songs.length + filteredCount;
}

class MusicApi {
  static VoidCallback? onAuthExpired;
  static bool _isAuthExpiredNotified = false;

  static MusicTransport _createDefaultTransport() => HttpMusicTransport(
    authExpirationHandler: _checkAuthExpiration,
    dataFormatter: _truncateData,
  );

  static MusicApiBackend _createDefaultBackend() =>
      HttpMusicApiBackend(transportProvider: () => _transport);

  static MusicTransport _transport = _createDefaultTransport();
  static MusicApiBackend _backend = _createDefaultBackend();

  static Future<void> setTransport(MusicTransport transport) async {
    await _transport.dispose();
    _transport = transport;
  }

  @visibleForTesting
  static Future<void> setBackend(MusicApiBackend backend) async {
    await _backend.dispose();
    _backend = backend;
    await syncBackendAuthState();
  }

  @visibleForTesting
  static Future<void> resetTransport() async {
    await _backend.dispose();
    await _transport.dispose();
    _transport = _createDefaultTransport();
    _backend = _createDefaultBackend();
    _isAuthExpiredNotified = false;
    await syncBackendAuthState();
  }

  static Future<void> syncBackendAuthState() async {
    final cookie = await MusicApiStoredAuth.loadCookieValue();
    await _backend.syncAuthCookie(cookie);
  }

  static String _truncateData(dynamic data) {
    if (data == null) return 'null';
    final String str = data is String ? data : jsonEncode(data);
    const int maxLength = 1000;
    if (str.length <= maxLength) return str;
    return '${str.substring(0, maxLength)}... (truncated, total length: ${str.length})';
  }

  static void _checkAuthExpiration(String path, dynamic data) {
    if (data is! Map) return;

    // Define expiration detection rules
    final rules = [
      // Rule 1: Global error code for expired token
      () => data['error_code'] == 20018,

      // Rule 3: VIP detail failure often means token invalid
      () => path.contains('/user/vip/detail') && data['status'] == 0,

      // Rule 4: General session expired message in data
      () => (data['msg']?.toString().contains('登录已过期') ?? false),
    ];

    bool isExpired = rules.any((rule) => rule());

    if (isExpired && !_isAuthExpiredNotified) {
      _isAuthExpiredNotified = true;
      LoggerService.w(
        '[MusicApi] Auth expiration detected at $path. Data: $data',
      );
      onAuthExpired?.call();

      // Reset after a delay to allow future notifications if user logs in and expires again
      Future.delayed(const Duration(seconds: 5), () {
        _isAuthExpiredNotified = false;
      });
    }
  }

  static Future<Map<String, dynamic>?> registerDevice() async {
    return _backend.registerDevice();
  }

  static Future<List<Song>> search(
    String keywords, {
    int page = 1,
    int pagesize = 30,
    String type = 'song',
  }) => _backend.search(keywords, page: page, pagesize: pagesize, type: type);

  static Future<Map<String, dynamic>> getSearchResult(
    String keywords, {
    String type = 'song',
    int page = 1,
    int pagesize = 30,
  }) => _backend.getSearchResult(
    keywords,
    type: type,
    page: page,
    pagesize: pagesize,
  );

  static Future<Map<String, dynamic>?> getSongUrl(
    String hash, {
    String quality = '',
  }) async {
    return _backend.getSongUrl(hash, quality: quality);
  }

  static Future<String?> getCloudSongUrl(String hash) =>
      _backend.getCloudSongUrl(hash);

  static Future<List<Map<String, dynamic>>> getSongPrivilege(
    String hash, {
    String? albumId,
  }) => _backend.getSongPrivilege(hash, albumId: albumId);

  static Future<Map<String, dynamic>> getSongRanking(dynamic albumAudioId) =>
      _backend.getSongRanking(albumAudioId);

  static Future<Map<String, dynamic>> getSongRankingFilter(
    dynamic albumAudioId, {
    int page = 1,
    int pagesize = 30,
  }) => _backend.getSongRankingFilter(
    albumAudioId,
    page: page,
    pagesize: pagesize,
  );

  static Future<Map<String, dynamic>> getFavoriteCount(String mixSongIds) =>
      _backend.getFavoriteCount(mixSongIds);

  static Future<Map<String, dynamic>> getCommentCount(
    String hash, {
    String? specialId,
  }) => _backend.getCommentCount(hash, specialId: specialId);

  static Future<Map<String, dynamic>> getMusicComments(
    dynamic mixSongId, {
    int page = 1,
    int pagesize = 30,
    int sort = 2,
    bool showClassify = false,
    bool showHotwordList = false,
  }) => _backend.getMusicComments(
    mixSongId,
    page: page,
    pagesize: pagesize,
    sort: sort,
    showClassify: showClassify,
    showHotwordList: showHotwordList,
  );

  static Future<Map<String, dynamic>> getMusicClassifyComments(
    dynamic mixSongId,
    int typeId, {
    int page = 1,
    int pagesize = 30,
    int sort = 2,
  }) => _backend.getMusicClassifyComments(
    mixSongId,
    typeId,
    page: page,
    pagesize: pagesize,
    sort: sort,
  );

  static Future<Map<String, dynamic>> getMusicHotwordComments(
    dynamic mixSongId,
    String hotWord, {
    int page = 1,
    int pagesize = 30,
    int sort = 2,
  }) => _backend.getMusicHotwordComments(
    mixSongId,
    hotWord,
    page: page,
    pagesize: pagesize,
    sort: sort,
  );

  static Future<List<Song>> getNewSongs() async {
    return _backend.getNewSongs();
  }

  static Future<List<Map<String, dynamic>>> getRanks() => _backend.getRanks();

  static Future<List<Map<String, dynamic>>> getRankTop() =>
      _backend.getRankTop();

  static Future<List<Song>> getRankSongs(int rankId) =>
      _backend.getRankSongs(rankId);

  static Future<List<Playlist>> getRecommendPlaylists() =>
      _backend.getRecommendPlaylists();

  static Future<Map<String, dynamic>?> getPlaylistDetail(String ids) =>
      _backend.getPlaylistDetail(ids);

  static Future<Map<String, dynamic>> getPlaylistTrackAll(
    String id, {
    int page = 1,
    int pagesize = 30,
  }) async {
    return _backend.getPlaylistTrackAll(id, page: page, pagesize: pagesize);
  }

  static Future<Map<String, dynamic>> getPlaylistTrackAllNew(
    int listid, {
    int page = 1,
    int pagesize = 200,
  }) => _backend.getPlaylistTrackAllNew(listid, page: page, pagesize: pagesize);

  static Future<List<Song>> getPlaylistSongs(
    dynamic id, {
    int? listid,
    String? listCreateGid,
    int? listCreateUserid,
    int page = 1,
    int pagesize = 200,
  }) async {
    try {
      final queryId = await resolvePlaylistTrackQueryId(
        id,
        listid: listid,
        listCreateGid: listCreateGid,
        listCreateUserid: listCreateUserid,
      );

      if (queryId.isEmpty || queryId == '0' || queryId == 'null') return [];

      final responseData = await getPlaylistTrackAll(
        queryId,
        page: page,
        pagesize: pagesize,
      );
      return parsePlaylistSongsFromResponse(responseData).songs;
    } catch (e) {
      LoggerService.e('getPlaylistSongs error: $e');
      return [];
    }
  }

  static Future<PlaylistSongsParseResult> getPlaylistSongsWithMetadata(
    dynamic id, {
    int? listid,
    String? listCreateGid,
    int? listCreateUserid,
    int page = 1,
    int pagesize = 200,
  }) async {
    try {
      final queryId = await resolvePlaylistTrackQueryId(
        id,
        listid: listid,
        listCreateGid: listCreateGid,
        listCreateUserid: listCreateUserid,
      );

      if (queryId.isEmpty || queryId == '0' || queryId == 'null') {
        return const PlaylistSongsParseResult(songs: []);
      }

      final responseData = await getPlaylistTrackAll(
        queryId,
        page: page,
        pagesize: pagesize,
      );
      return parsePlaylistSongsFromResponse(responseData);
    } catch (e) {
      LoggerService.e('getPlaylistSongsWithMetadata error: $e');
      return const PlaylistSongsParseResult(songs: []);
    }
  }

  static Future<String> resolvePlaylistTrackQueryId(
    dynamic id, {
    int? listid,
    String? listCreateGid,
    int? listCreateUserid,
  }) async {
    String queryId = id?.toString() ?? '';

    if (listid != null && listid != 0) {
      final prefs = await SharedPreferences.getInstance();
      final userInfoJson = prefs.getString('user_info');
      int? currentUserId;
      if (userInfoJson != null) {
        currentUserId = jsonDecode(userInfoJson)['userid'];
      }

      if (listCreateUserid != null &&
          currentUserId != null &&
          listCreateUserid != currentUserId) {
        if (listCreateGid != null &&
            listCreateGid != '0' &&
            listCreateGid != 'null') {
          queryId = listCreateGid;
        }
      }
    }

    return queryId;
  }

  static List<Song> parseSongsFromResponse(Map<String, dynamic> responseData) {
    return parsePlaylistSongsFromResponse(responseData).songs;
  }

  static PlaylistSongsParseResult parsePlaylistSongsFromResponse(
    Map<String, dynamic> responseData,
  ) {
    final data = responseData['data'] ?? responseData;
    List? list;

    if (data is Map) {
      // 优先提取歌曲列表字段
      list =
          data['songs'] ??
          data['info'] ??
          data['list'] ??
          data['songlist'] ??
          data['song_list'];

      // 兼容嵌套结构
      if (list == null && data['info'] is Map) {
        list =
            data['info']['list'] ??
            data['info']['songs'] ??
            data['info']['songlist'];
      }
    } else if (data is List) {
      list = data;
    }

    final List songsData = list ?? [];

    final songs = <Song>[];
    var filteredCount = 0;
    for (final rawSong in songsData.whereType<Map<String, dynamic>>()) {
      final song = Song.fromPlaylistJson(rawSong);

      if (_isMeaninglessHashlessSong(song)) {
        filteredCount++;
        continue;
      }

      songs.add(song);
    }

    return PlaylistSongsParseResult(songs: songs, filteredCount: filteredCount);
  }

  static bool _isMeaninglessHashlessSong(Song song) {
    return song.hash.isEmpty &&
        song.name.trim().isEmpty &&
        song.singers.isEmpty &&
        song.albumName.trim().isEmpty &&
        song.cover.trim().isEmpty &&
        song.mixSongId == 0;
  }

  static Future<Map<String, dynamic>?> searchLyric(String hash) =>
      _backend.searchLyric(hash);

  static Future<Map<String, dynamic>?> getLyric(String id, String accesskey) =>
      _backend.getLyric(id, accesskey);

  // --- Artist ---
  static Future<Map<String, dynamic>?> getSingerDetail(int id) =>
      _backend.getSingerDetail(id);

  static Future<List<Song>> getSingerSongs(
    int id, {
    int page = 1,
    int pagesize = 200,
    String sort = 'hot',
  }) => _backend.getSingerSongs(id, page: page, pagesize: pagesize, sort: sort);

  static Future<bool> followSinger(int id) => _backend.followSinger(id);

  static Future<bool> unfollowSinger(int id) => _backend.unfollowSinger(id);

  // --- Album ---
  static Future<Map<String, dynamic>?> getAlbumDetail(int id) =>
      _backend.getAlbumDetail(id);

  static Future<List<Song>> getAlbumSongs(
    int id, {
    int page = 1,
    int pagesize = 50,
  }) => _backend.getAlbumSongs(id, page: page, pagesize: pagesize);

  static Future<Map<String, dynamic>> getAlbumTop() => _backend.getAlbumTop();

  // --- User / Auth ---
  static Future<bool> captchaSent(String mobile) =>
      _backend.captchaSent(mobile);

  static Future<Map<String, dynamic>> loginCellphone(
    String mobile,
    String code, {
    int? userid,
  }) => _backend.loginCellphone(mobile, code, userid: userid);

  static Future<Map<String, dynamic>?> loginQrKey() => _backend.loginQrKey();

  static Future<Map<String, dynamic>?> loginQrCreate(String key) =>
      _backend.loginQrCreate(key);

  static Future<Map<String, dynamic>?> loginQrCheck(String key) =>
      _backend.loginQrCheck(key);

  static Future<Map<String, dynamic>?> loginWxCreate() =>
      _backend.loginWxCreate();

  static Future<dynamic> loginWxCheck(String uuid) =>
      _backend.loginWxCheck(uuid);

  static Future<Map<String, dynamic>> loginOpenPlat(String code) =>
      _backend.loginOpenPlat(code);

  static Future<Map<String, dynamic>?> userDetail() => _backend.userDetail();

  static Future<Map<String, dynamic>?> userVipDetail() =>
      _backend.userVipDetail();

  static Future<List<Map<String, dynamic>>> getUserFollow() =>
      _backend.getUserFollow();

  static Future<Map<String, dynamic>> getUserPlayHistory({String? bp}) =>
      _backend.getUserPlayHistory(bp: bp);

  static Future<bool> uploadPlayHistory(int mixSongId) =>
      _backend.uploadPlayHistory(mixSongId);

  static Future<Map<String, dynamic>> getUserCloud({
    int page = 1,
    int pagesize = 30,
  }) => _backend.getUserCloud(page: page, pagesize: pagesize);

  // --- Playlist ---
  static Future<List<Map<String, dynamic>>> getUserPlaylists({
    int page = 1,
    int pagesize = 30,
  }) async {
    try {
      final response = await getUserPlaylistsRaw(
        page: page,
        pagesize: pagesize,
      );
      if (response['status'] == 1) {
        List data = response['data']['info'] ?? [];
        return data.cast<Map<String, dynamic>>();
      }
      return [];
    } catch (e) {
      return [];
    }
  }

  static Future<Map<String, dynamic>> getUserPlaylistsRaw({
    int page = 1,
    int pagesize = 30,
  }) => _backend.getUserPlaylistsRaw(page: page, pagesize: pagesize);

  static Future<bool> copyPlaylist(
    int playlistId,
    String name, {
    int? listCreateUserid,
    String? listCreateGid,
    int? listCreateListid,
    bool isPrivate = false,
    int source = 1,
  }) async {
    return addPlaylist(
      name,
      isPri: isPrivate ? 1 : 0,
      type: 1, // Type 1 as per legacy project for collecting/liking playlist
      listCreateListid: listCreateListid ?? playlistId,
      listCreateUserid: listCreateUserid,
      listCreateGid: listCreateGid,
      source: source,
    );
  }

  static Future<bool> addPlaylist(
    String name, {
    int isPri = 0,
    int type = 0,
    int? listCreateUserid,
    int? listCreateListid,
    String? listCreateGid,
    int source = 1,
  }) => _backend.addPlaylist(
    name,
    isPri: isPri,
    type: type,
    listCreateUserid: listCreateUserid,
    listCreateListid: listCreateListid,
    listCreateGid: listCreateGid,
    source: source,
  );

  static Future<bool> deletePlaylist(int listid) =>
      _backend.deletePlaylist(listid);

  static Future<bool> addPlaylistTrack(dynamic listid, String data) =>
      _backend.addPlaylistTrack(listid, data);

  static Future<bool> deletePlaylistTrack(dynamic listid, String fileids) =>
      _backend.deletePlaylistTrack(listid, fileids);

  static Future<List<Map<String, dynamic>>> getPlaylistCategory() =>
      _backend.getPlaylistCategory();

  static Future<List<Playlist>> getPlaylistByCategory(
    String categoryId, {
    int withsong = 0,
    int withtag = 1,
  }) => _backend.getPlaylistByCategory(
    categoryId,
    withsong: withsong,
    withtag: withtag,
  );

  // --- Search Expanded ---
  static Future<String> getSearchDefault() => _backend.getSearchDefault();

  static Future<List<String>> getSearchHot() => _backend.getSearchHot();

  static Future<List<Map<String, dynamic>>> getSearchHotCategorized() =>
      _backend.getSearchHotCategorized();

  static Future<List<Map<String, dynamic>>> getSearchSuggest(String keywords) =>
      _backend.getSearchSuggest(keywords);

  static Future<List<Song>> getEverydayRecommend() =>
      _backend.getEverydayRecommend();

  static Future<List<Map<String, dynamic>>> getTopIP() => _backend.getTopIP();

  static Future<List<Map<String, dynamic>>> getIPData(
    int id, {
    String type = '',
    int page = 1,
    int pagesize = 30,
  }) => _backend.getIPData(id, type: type, page: page, pagesize: pagesize);

  static Future<List<Map<String, dynamic>>> getTopPlaylistByIP(
    int id, {
    int page = 1,
    int pagesize = 30,
  }) => _backend.getTopPlaylistByIP(id, page: page, pagesize: pagesize);

  static Future<List<Song>> getSongClimax(String hash) =>
      _backend.getSongClimax(hash);

  static Future<List<Map<String, dynamic>>> getSongClimaxRaw(String hash) =>
      _backend.getSongClimaxRaw(hash);

  // --- VIP Claiming (Experimental) ---

  static Future<bool> claimDayVip(String day) => _backend.claimDayVip(day);

  static Future<bool> upgradeDayVip() => _backend.upgradeDayVip();

  static Future<Map<String, dynamic>> getVipMonthRecord() =>
      _backend.getVipMonthRecord();
}
