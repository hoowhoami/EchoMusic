import 'dart:convert';
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../models/song.dart';
import '../models/playlist.dart';

class MusicApi {
  static VoidCallback? onAuthExpired;
  static bool _isAuthExpiredNotified = false;

  static final Dio _dio = Dio(BaseOptions(
    baseUrl: 'http://localhost:10086',
    connectTimeout: const Duration(seconds: 10),
    receiveTimeout: const Duration(seconds: 10),
  ))
    ..interceptors.add(InterceptorsWrapper(
      onRequest: (options, handler) async {
        final prefs = await SharedPreferences.getInstance();
        
        // Retrieve device and user info from storage
        final deviceJson = prefs.getString('device_info');
        final userInfoJson = prefs.getString('user_info');
        
        final device = deviceJson != null ? jsonDecode(deviceJson) : null;
        final userInfo = userInfoJson != null ? jsonDecode(userInfoJson) : null;

        final token = userInfo?['token'];
        final userid = userInfo?['userid'];
        final t1 = userInfo?['t1'];
        final dfid = device?['dfid'];
        final mid = device?['mid'];
        final guid = device?['guid'];
        final serverDev = device?['serverDev'];
        final mac = device?['mac'];

        final authParts = <String>[];
        if (token != null) authParts.add('token=$token');
        if (userid != null) authParts.add('userid=$userid');
        if (dfid != null) authParts.add('dfid=$dfid');
        if (t1 != null) authParts.add('t1=$t1');
        if (mid != null) authParts.add('KUGOU_API_MID=$mid');
        if (guid != null) authParts.add('KUGOU_API_GUID=$guid');
        if (serverDev != null) authParts.add('KUGOU_API_DEV=$serverDev');
        if (mac != null) authParts.add('KUGOU_API_MAC=$mac');

        if (authParts.isNotEmpty) {
          options.headers['Authorization'] = authParts.join(';');
        }

        options.queryParameters['t'] = DateTime.now().millisecondsSinceEpoch;

        debugPrint('--> ${options.method} ${options.uri}');
        
        return handler.next(options);
      },
      onResponse: (response, handler) {
        _checkAuthExpiration(response.requestOptions.path, response.data);
        return handler.next(response);
      },
      onError: (err, handler) {
        if (err.response != null) {
          _checkAuthExpiration(err.requestOptions.path, err.response!.data);
        }
        return handler.next(err);
      },
    ));

  static void _checkAuthExpiration(String path, dynamic data) {
    if (data is! Map) return;

    // Define expiration detection rules
    final rules = [
      // Rule 1: Global error code for expired token
      () => data['error_code'] == 20018,
      
      // Rule 2: Song URL specifically indicates auth required/expired
      () => path.contains('/song/url') && data['status'] == 2,
      
      // Rule 3: VIP detail failure often means token invalid
      () => path.contains('/user/vip/detail') && data['status'] == 0,
      
      // Rule 4: General session expired message in data
      () => (data['msg']?.toString().contains('登录已过期') ?? false),
    ];

    bool isExpired = rules.any((rule) => rule());

    if (isExpired && !_isAuthExpiredNotified) {
      _isAuthExpiredNotified = true;
      debugPrint('[MusicApi] Auth expiration detected at $path. Data: $data');
      onAuthExpired?.call();
      
      // Reset after a delay to allow future notifications if user logs in and expires again
      Future.delayed(const Duration(seconds: 5), () {
        _isAuthExpiredNotified = false;
      });
    }
  }

  static Future<Map<String, dynamic>?> registerDevice() async {
    try {
      final response = await _dio.get('/register/dev');
      if (response.data['status'] == 1) {
        return response.data['data'];
      }
      return null;
    } catch (e) {
      // Error is already printed by interceptor
      return null;
    }
  }

  static Future<List<Song>> search(String keywords, {int page = 1, int pagesize = 30, String type = 'song'}) async {
    try {
      final response = await _dio.get('/search', queryParameters: {
        'keywords': keywords,
        'page': page,
        'pagesize': pagesize,
        'type': type,
      });
      if (response.data['status'] == 1) {
        List data = response.data['data']['lists'] ?? [];
        return data.map((json) => Song.fromSearchJson(json)).toList();
      }
      return [];
    } catch (e) {
      return [];
    }
  }

  static Future<Map<String, dynamic>> getSearchResult(String keywords, {String type = 'song', int page = 1, int pagesize = 30}) async {
    try {
      final response = await _dio.get('/search', queryParameters: {
        'keywords': keywords,
        'page': page,
        'pagesize': pagesize,
        'type': type,
      });
      return response.data;
    } catch (e) {
      return {};
    }
  }

  static Future<Map<String, dynamic>?> getSongUrl(String hash, {String quality = ''}) async {
    try {
      final params = <String, dynamic>{
        'hash': hash,
      };
      if (quality.isNotEmpty) {
        params['quality'] = quality;
      }
      final response = await _dio.get('/song/url', queryParameters: params);
      
      if (response.data != null) {
        final status = response.data['status'];
        // Some responses have data at root, some in a 'data' field
        final payload = response.data['data'] ?? response.data;
        final urlData = payload['url'];
        
        String? url;
        if (urlData is List && urlData.isNotEmpty) {
          url = urlData[0].toString();
        } else if (urlData is String) {
          url = urlData;
        }

        return {
          'url': url,
          'status': status,
        };
      }
      return null;
    } catch (e) {
      debugPrint('getSongUrl error: $e');
      return null;
    }
  }

  static Future<String?> getCloudSongUrl(String hash) async {
    try {
      final response = await _dio.get('/user/cloud/url', queryParameters: {'hash': hash});
      if (response.data['status'] == 1) {
        return response.data['data']?['url'];
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  static Future<List<Map<String, dynamic>>> getSongPrivilege(String hash, {String? albumId}) async {
    try {
      final params = {'hash': hash};
      if (albumId != null && albumId != '0' && albumId.isNotEmpty) {
        params['album_id'] = albumId;
      }
      
      final response = await _dio.get('/privilege/lite', queryParameters: params);
      if (response.data['status'] == 1) {
        final List data = response.data['data'] ?? [];
        return data.cast<Map<String, dynamic>>();
      }
      return [];
    } catch (e) {
      debugPrint('getSongPrivilege error: $e');
      return [];
    }
  }

  static Future<List<Song>> getNewSongs() async {
    try {
      final response = await _dio.get('/top/song');
      if (response.data['status'] == 1) {
        List data = response.data['data'] ?? [];
        return data.map((json) => Song.fromTopSongJson(json)).toList();
      }
      return [];
    } catch (e) {
      return [];
    }
  }

  static Future<List<Map<String, dynamic>>> getRanks() async {
    try {
      final response = await _dio.get('/rank/list');
      if (response.data['status'] == 1) {
        List data = response.data['data']['info'] ?? [];
        return data.cast<Map<String, dynamic>>();
      }
      debugPrint('getRanks status != 1: ${response.data}');
      return [];
    } catch (e) {
      debugPrint('getRanks error: $e');
      return [];
    }
  }

  static Future<List<Map<String, dynamic>>> getRankTop() async {
    try {
      final response = await _dio.get('/rank/top');
      if (response.data['status'] == 1) {
        // Based on EchoMusicLegacy, the data is in response.data['data']['list'] or similar
        // Looking at server/module/rank_top.js, it returns the raw response from Kugou
        List data = response.data['data']?['list'] ?? response.data['list'] ?? [];
        return data.cast<Map<String, dynamic>>();
      }
      return [];
    } catch (e) {
      return [];
    }
  }

  static Future<List<Song>> getRankSongs(int rankId) async {
    try {
      final response = await _dio.get('/rank/audio', queryParameters: {
        'rankid': rankId,
        'pagesize': 100, // Fetch more songs
      });
      if (response.data['status'] == 1) {
        var data = response.data['data'];
        List? list;
        if (data is Map) {
          list = data['list'] ?? data['info'] ?? data['songlist'] ?? data['songs']?['list'];
        } else if (data is List) {
          list = data;
        }
        
        if (list != null) {
          return list.map((json) => Song.fromRankJson(json)).toList();
        }
      }
      return [];
    } catch (e) {
      return [];
    }
  }

  static Future<List<Playlist>> getRecommendPlaylists() async {
    try {
      final response = await _dio.get('/playlist/recommend');
      if (response.data['status'] == 1) {
        List data = response.data['data']['list'] ?? response.data['data']['special_list'] ?? [];
        return data.map((json) => Playlist.fromSpecialPlaylist(json)).toList();
      }
      return [];
    } catch (e) {
      return [];
    }
  }

  static Future<Map<String, dynamic>?> getPlaylistDetail(String ids) async {
    try {
      final response = await _dio.get('/playlist/detail', queryParameters: {'ids': ids});
      if (response.data['status'] == 1) {
        List data = response.data['data'] ?? [];
        return data.isNotEmpty ? data[0] : null;
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  static Future<Map<String, dynamic>> getPlaylistTrackAll(String id, {int page = 1, int pagesize = 30}) async {
    try {
      final response = await _dio.get('/playlist/track/all', queryParameters: {
        'id': id,
        'page': page,
        'pagesize': pagesize,
      });
      return response.data ?? {};
    } catch (e) {
      return {};
    }
  }

  static Future<Map<String, dynamic>> getPlaylistTrackAllNew(int listid, {int page = 1, int pagesize = 100}) async {
    try {
      final response = await _dio.get('/playlist/track/all/new', queryParameters: {
        'listid': listid,
        'page': page,
        'pagesize': pagesize,
      });
      return response.data ?? {};
    } catch (e) {
      return {};
    }
  }

  static Future<List<Song>> getPlaylistSongs(
    dynamic id, {
    int? listid,
    String? listCreateGid,
    int? listCreateUserid,
  }) async {
    try {
      String queryId = id?.toString() ?? '';
      
      if (listid != null && listid != 0) {
        // 获取当前用户 ID 用于判定所有权
        final prefs = await SharedPreferences.getInstance();
        final userInfoJson = prefs.getString('user_info');
        int? currentUserId;
        if (userInfoJson != null) {
          currentUserId = jsonDecode(userInfoJson)['userid'];
        }

        // 判定逻辑：如果创建者不是自己，说明是收藏的他人歌单，必须换用 listCreateGid
        if (listCreateUserid != null && currentUserId != null && listCreateUserid != currentUserId) {
          if (listCreateGid != null && listCreateGid != '0' && listCreateGid != 'null') {
            queryId = listCreateGid;
          }
        }
      }

      if (queryId.isEmpty || queryId == '0' || queryId == 'null') return [];
      
      final responseData = await getPlaylistTrackAll(queryId, pagesize: 500);
      return _parseSongsFromResponse(responseData);
    } catch (e) {
      debugPrint('getPlaylistSongs error: $e');
      return [];
    }
  }

  static List<Song> _parseSongsFromResponse(Map<String, dynamic> responseData) {
    final data = responseData['data'] ?? responseData;
    List? list;
    
    if (data is Map) {
      // 优先提取歌曲列表字段
      list = data['songs'] ?? data['info'] ?? data['list'] ?? data['songlist'] ?? data['song_list'];
      
      // 兼容嵌套结构
      if (list == null && data['info'] is Map) {
        list = data['info']['list'] ?? data['info']['songs'] ?? data['info']['songlist'];
      }
    } else if (data is List) {
      list = data;
    }
    
    final List songsData = list ?? [];
    
    return songsData
        .whereType<Map<String, dynamic>>()
        .map((json) => Song.fromPlaylistJson(json))
        .where((song) => song.hash.isNotEmpty)
        .toList();
  }

  static Future<Map<String, dynamic>?> searchLyric(String hash) async {
    try {
      final response = await _dio.get('/search/lyric', queryParameters: {
        'hash': hash,
      });
      debugPrint('Raw searchLyric Response: ${response.data}');
      if (response.data != null && (response.data['status'] == 1 || response.data['status'] == 200)) {
        return response.data;
      }
      return null;
    } catch (e) {
      debugPrint('searchLyric Error: $e');
      return null;
    }
  }

  static Future<Map<String, dynamic>?> getLyric(String id, String accesskey) async {
    try {
      final response = await _dio.get('/lyric', queryParameters: {
        'id': id,
        'accesskey': accesskey,
        'decode': 'true',
        'fmt': 'krc',
      });
      debugPrint('Raw getLyric Response: ${response.data}');
      if (response.data != null) {
        // Support direct body return or wrapped in 'data'
        final data = response.data['data'] ?? response.data;
        if (response.data['status'] == 1 || response.data['status'] == 200 || data['decodeContent'] != null) {
          return data is Map ? Map<String, dynamic>.from(data) : null;
        }
      }
      return null;
    } catch (e) {
      debugPrint('getLyric Error: $e');
      return null;
    }
  }

  // --- Artist ---
  static Future<Map<String, dynamic>?> getSingerDetail(int id) async {
    try {
      final response = await _dio.get('/artist/detail', queryParameters: {'id': id});
      if (response.data['status'] == 1) return response.data['data'];
      return null;
    } catch (e) {
      return null;
    }
  }

  static Future<List<Song>> getSingerSongs(int id, {int page = 1, int pagesize = 30, String sort = 'hot'}) async {
    try {
      final response = await _dio.get('/artist/audios', queryParameters: {
        'id': id,
        'page': page,
        'pagesize': pagesize,
        'sort': sort,
      });
      if (response.data['status'] == 1) {
        final rawData = response.data['data'];
        final List data = rawData is List ? rawData : (rawData['info'] ?? rawData['list'] ?? []);
        return data.map((json) => Song.fromArtistSongJson(json)).toList();
      }
      return [];
    } catch (e) {
      return [];
    }
  }

  static Future<bool> followSinger(int id) async {
    try {
      final response = await _dio.get('/artist/follow', queryParameters: {'id': id});
      return response.data['status'] == 1;
    } catch (e) {
      return false;
    }
  }

  static Future<bool> unfollowSinger(int id) async {
    try {
      final response = await _dio.get('/artist/unfollow', queryParameters: {'id': id});
      return response.data['status'] == 1;
    } catch (e) {
      return false;
    }
  }

  // --- Album ---
  static Future<Map<String, dynamic>?> getAlbumDetail(int id) async {
    try {
      final response = await _dio.get('/album/detail', queryParameters: {'id': id});
      if (response.data['status'] == 1) return response.data['data'];
      return null;
    } catch (e) {
      return null;
    }
  }

  static Future<List<Song>> getAlbumSongs(int id, {int page = 1, int pagesize = 30}) async {
    try {
      final response = await _dio.get('/album/songs', queryParameters: {
        'id': id,
        'page': page,
        'pagesize': pagesize,
      });
      if (response.data['status'] == 1) {
        final rawData = response.data['data'];
        final List data = rawData is List ? rawData : (rawData['songs'] ?? rawData['info'] ?? rawData['list'] ?? []);
        return data.map((json) => Song.fromAlbumJson(json)).toList();
      }
      return [];
    } catch (e) {
      return [];
    }
  }

  static Future<Map<String, dynamic>> getAlbumTop() async {
    try {
      final response = await _dio.get('/top/album');
      if (response.data['status'] == 1) {
        return response.data['data'] ?? {};
      }
      return {};
    } catch (e) {
      return {};
    }
  }

  // --- User / Auth ---
  static Future<bool> captchaSent(String mobile) async {
    try {
      final response = await _dio.get('/captcha/sent', queryParameters: {'mobile': mobile});
      return response.data['status'] == 1;
    } catch (e) {
      return false;
    }
  }

  static Future<Map<String, dynamic>> loginCellphone(String mobile, String code, {int? userid}) async {
    try {
      final queryParams = {
        'mobile': mobile,
        'code': code,
      };
      if (userid != null) {
        queryParams['userid'] = userid.toString();
      }
      final response = await _dio.get('/login/cellphone', queryParameters: queryParams);
      return response.data;
    } on DioException catch (e) {
      if (e.response?.data != null) {
        return e.response!.data is Map ? e.response!.data : {'status': 0, 'error': e.message};
      }
      return {'status': 0, 'error': e.message};
    } catch (e) {
      return {'status': 0, 'error': e.toString()};
    }
  }

  static Future<Map<String, dynamic>?> loginQrKey() async {
    try {
      final response = await _dio.get('/login/qr/key');
      debugPrint('loginQrKey response: ${response.data}');

      // 检查响应格式
      if (response.data != null && response.data['status'] == 1 && response.data['data'] != null) {
        final data = response.data['data'];

        // 实际API返回格式：{qrcode: "xxx", qrcode_img: "data:image/png;base64,..."}
        // 转换为期望格式：{key: "xxx", qrcode_url: "xxx"}
        if (data['qrcode'] != null) {
          return {
            'key': data['qrcode'],
            'qrcode_url': data['qrcode_img'], // 直接使用 base64 图片
          };
        }

        // 标准格式：{key: xxx, qrcode_url: xxx}
        if (data['key'] != null) {
          return data;
        }

        return data;
      }

      debugPrint('loginQrKey: 无法解析响应数据');
      return null;
    } catch (e) {
      debugPrint('loginQrKey error: $e');
      return null;
    }
  }

  static Future<Map<String, dynamic>?> loginQrCreate(String key) async {
    try {
      final response = await _dio.get('/login/qr/create', queryParameters: {'key': key, 'qrimg': 'true'});
      debugPrint('loginQrCreate response: ${response.data}');

      if (response.data != null) {
        // 格式1: {code: 200, data: {url: "xxx", base64: "xxx"}}
        if (response.data['code'] == 200 && response.data['data'] != null) {
          final data = response.data['data'];
          if (data['base64'] != null || data['url'] != null) {
            return {
              'qrcode_url': data['base64'] ?? data['url'],
            };
          }
        }

        // 格式2: {status: 1, data: {qrcode_url: xxx}}
        if (response.data['status'] == 1 && response.data['data'] != null) {
          return response.data['data'];
        }

        // 格式3: 直接返回 {qrcode_url: xxx}
        if (response.data['qrcode_url'] != null) {
          return response.data;
        }
      }
      debugPrint('loginQrCreate: 无法解析响应数据');
      return null;
    } catch (e) {
      debugPrint('loginQrCreate error: $e');
      return null;
    }
  }

  static Future<Map<String, dynamic>?> loginQrCheck(String key) async {
    try {
      final response = await _dio.get('/login/qr/check', queryParameters: {'key': key});
      return response.data;
    } catch (e) {
      return null;
    }
  }

  static Future<Map<String, dynamic>?> userDetail() async {
    try {
      final response = await _dio.get('/user/detail');
      if (response.data['status'] == 1) return response.data['data'];
      return null;
    } catch (e) {
      return null;
    }
  }

  static Future<Map<String, dynamic>?> userVipDetail() async {
    try {
      final response = await _dio.get('/user/vip/detail');
      if (response.data['status'] == 1) return response.data['data'];
      return null;
    } catch (e) {
      return null;
    }
  }

  static Future<List<Map<String, dynamic>>> getUserFollow() async {
    try {
      final response = await _dio.get('/user/follow');
      if (response.data['status'] == 1) {
        List data = response.data['data']['lists'] ?? [];
        return data.cast<Map<String, dynamic>>();
      }
      return [];
    } catch (e) {
      return [];
    }
  }

  static Future<List<Song>> getUserPlayHistory({int? bp}) async {
    try {
      final response = await _dio.get('/user/history', queryParameters: bp != null ? {'bp': bp} : {});
      if (response.data['status'] == 1) {
        List data = response.data['data']?['list'] ?? [];
        return data
            .where((item) => item['info'] != null)
            .map((item) => Song.fromPlaylistJson(item['info']))
            .toList();
      }
      return [];
    } catch (e) {
      return [];
    }
  }

  static Future<List<Song>> getUserCloud({int page = 1, int pagesize = 30}) async {
    try {
      final response = await _dio.get('/user/cloud', queryParameters: {'page': page, 'pagesize': pagesize});
      if (response.data['status'] == 1) {
        List data = response.data['data']?['list'] ?? [];
        return data.map((json) => Song.fromCloudJson(json)).toList();
      }
      return [];
    } catch (e) {
      return [];
    }
  }

  // --- Playlist ---
  static Future<List<Map<String, dynamic>>> getUserPlaylists({int page = 1, int pagesize = 30}) async {
    try {
      final response = await getUserPlaylistsRaw(page: page, pagesize: pagesize);
      if (response['status'] == 1) {
        List data = response['data']['info'] ?? [];
        return data.cast<Map<String, dynamic>>();
      }
      return [];
    } catch (e) {
      return [];
    }
  }

  static Future<Map<String, dynamic>> getUserPlaylistsRaw({int page = 1, int pagesize = 30}) async {
    try {
      final response = await _dio.get('/user/playlist', queryParameters: {'page': page, 'pagesize': pagesize});
      return response.data ?? {};
    } catch (e) {
      return {'status': 0, 'error': e.toString()};
    }
  }

  static Future<bool> copyPlaylist(int playlistId, String name, {int? listCreateUserid, String? listCreateGid, int? listCreateListid, bool isPrivate = false, int source = 1}) async {
    return addPlaylist(
      name,
      isPri: isPrivate ? 1 : 0,
      type: 1, // Type 1 as per legacy project for collecting/liking playlist
      list_create_listid: listCreateListid ?? playlistId,
      list_create_userid: listCreateUserid,
      list_create_gid: listCreateGid,
      source: source,
    );
  }

  static Future<bool> addPlaylist(String name, {int isPri = 0, int type = 0, int? list_create_userid, int? list_create_listid, String? list_create_gid, int source = 1}) async {
    try {
      final params = {
        'name': name,
        'is_pri': isPri,
        'type': type,
        'source': source,
      };
      if (list_create_userid != null) params['list_create_userid'] = list_create_userid;
      if (list_create_listid != null) params['list_create_listid'] = list_create_listid;
      if (list_create_gid != null) params['list_create_gid'] = list_create_gid;

      final response = await _dio.get('/playlist/add', queryParameters: params);
      return response.data['status'] == 1;
    } catch (e) {
      return false;
    }
  }

  static Future<bool> deletePlaylist(int listid) async {
    try {
      final response = await _dio.get('/playlist/del', queryParameters: {'listid': listid});
      return response.data['status'] == 1;
    } catch (e) {
      return false;
    }
  }

  static Future<bool> addPlaylistTrack(int listid, String data) async {
    try {
      final response = await _dio.get('/playlist/tracks/add', queryParameters: {'listid': listid, 'data': data});
      return response.data['status'] == 1;
    } catch (e) {
      return false;
    }
  }

  static Future<bool> deletePlaylistTrack(int listid, String fileids) async {
    try {
      final response = await _dio.get('/playlist/tracks/del', queryParameters: {'listid': listid, 'fileids': fileids});
      return response.data['status'] == 1;
    } catch (e) {
      return false;
    }
  }

  static Future<List<Map<String, dynamic>>> getPlaylistCategory() async {
    try {
      final response = await _dio.get('/playlist/tags');
      if (response.data['status'] == 1) {
        List data = response.data['data'] ?? [];
        return data.cast<Map<String, dynamic>>();
      }
      return [];
    } catch (e) {
      return [];
    }
  }

  static Future<List<Playlist>> getPlaylistByCategory(String categoryId, {int withsong = 0, int withtag = 1}) async {
    try {
      final response = await _dio.get('/top/playlist', queryParameters: {
        'category_id': categoryId,
        'withsong': withsong,
        'withtag': withtag,
      });
      final root = response.data is Map ? response.data : {};
      if (root['status'] == 1) {
        final List data = root['data']?['special_list'] ?? 
                         root['data']?['list'] ?? 
                         root['special_list'] ?? 
                         root['list'] ?? [];
        return data.map((json) => Playlist.fromSpecialPlaylist(json)).toList();
      }
      return [];
    } catch (e) {
      return [];
    }
  }

  // --- Search Expanded ---
  static Future<String> getSearchDefault() async {
    try {
      final response = await _dio.get('/search/default');
      if (response.data['status'] == 1) return response.data['data']['keyword'] ?? '';
      return '';
    } catch (e) {
      return '';
    }
  }

  static Future<List<String>> getSearchHot() async {
    try {
      final response = await _dio.get('/search/hot');
      if (response.data['status'] == 1) {
        List data = response.data['data']['info'] ?? [];
        return data.map((e) => e['keyword'].toString()).toList();
      }
      return [];
    } catch (e) {
      return [];
    }
  }

  static Future<Map<String, dynamic>> getSearchSuggest(String keywords) async {
    try {
      final response = await _dio.get('/search/suggest', queryParameters: {'keywords': keywords});
      if (response.data['status'] == 1) return response.data['data'] ?? {};
      return {};
    } catch (e) {
      return {};
    }
  }

  static Future<List<Song>> getEverydayRecommend() async {
    try {
      final response = await _dio.get('/everyday/recommend');
      final root = response.data is Map ? response.data : {};
      if (root['status'] == 1) {
        final List data = root['data']?['song_list'] ?? 
                         root['song_list'] ?? 
                         root['data'] ?? [];
        return data.map((json) => Song.fromTopSongJson(json)).toList();
      }
      return [];
    } catch (e) {
      return [];
    }
  }

  static Future<List<Map<String, dynamic>>> getTopIP() async {
    try {
      final response = await _dio.get('/top/ip');
      final root = response.data is Map ? response.data : {};
      if (root['status'] == 1) {
        final List data = root['data']?['list'] ?? 
                         root['data'] ?? 
                         root['list'] ?? [];
        return data.cast<Map<String, dynamic>>();
      }
      return [];
    } catch (e) {
      return [];
    }
  }

  static Future<List<Map<String, dynamic>>> getIPData(int id, {String type = '', int page = 1, int pagesize = 30}) async {
    try {
      final response = await _dio.get('/ip', queryParameters: {
        'id': id,
        'type': type,
        'page': page,
        'pagesize': pagesize,
      });
      if (response.data['status'] == 1) {
        return (response.data['data']['list'] as List).cast<Map<String, dynamic>>();
      }
      return [];
    } catch (e) {
      return [];
    }
  }

  static Future<List<Map<String, dynamic>>> getTopPlaylistByIP(int id, {int page = 1, int pagesize = 30}) async {
    try {
      final response = await _dio.get('/ip/playlist', queryParameters: {
        'id': id,
        'page': page,
        'pagesize': pagesize,
      });
      if (response.data['status'] == 1) {
        return (response.data['data']['list'] as List).cast<Map<String, dynamic>>();
      }
      return [];
    } catch (e) {
      return [];
    }
  }

  static Future<List<Song>> getSongClimax(String hash) async {
    try {
      final response = await _dio.get('/song/climax', queryParameters: {'hash': hash});
      if (response.data['status'] == 1) {
        List data = response.data['data'] ?? [];
        return data.map((json) => Song.fromJson(json)).toList();
      }
      return [];
    } catch (e) {
      return [];
    }
  }

  static Future<List<Map<String, dynamic>>> getSongClimaxRaw(String hash) async {
    try {
      final response = await _dio.get('/song/climax', queryParameters: {'hash': hash});
      if (response.data['status'] == 1) {
        List data = response.data['data'] ?? [];
        return data.cast<Map<String, dynamic>>();
      }
      return [];
    } catch (e) {
      return [];
    }
  }

    // --- VIP Claiming (Experimental) ---

    static Future<bool> claimDayVip(String day) async {

      try {

        final response = await _dio.get('/youth/day/vip', queryParameters: {'receive_day': day});

        return response.data['status'] == 1;

      } catch (e) {

        return false;

      }

    }

  

    static Future<bool> upgradeDayVip() async {

      try {

        final response = await _dio.get('/youth/day/vip/upgrade');

        return response.data['status'] == 1;

      } catch (e) {

        return false;

      }

    }

  

    static Future<Map<String, dynamic>> getVipMonthRecord() async {

      try {

        final response = await _dio.get('/youth/month/vip/record');

        if (response.data['status'] == 1) {

          return response.data['data'] ?? {};

        }

        return {};

      } catch (e) {

        return {};

      }

    }

  }

  