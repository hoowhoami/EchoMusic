import 'dart:convert';
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';
import '../models/song.dart';
import '../models/playlist.dart';

class MusicApi {
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

        final authParts = <String>[];
        
        if (userInfo != null) {
          if (userInfo['token'] != null) authParts.add('token=${userInfo['token']}');
          if (userInfo['userid'] != null) authParts.add('userid=${userInfo['userid']}');
          if (userInfo['t1'] != null) authParts.add('t1=${userInfo['t1']}');
        }

        if (device != null) {
          if (device['mid'] != null) authParts.add('KUGOU_API_MID=${device['mid']}');
          if (device['guid'] != null) authParts.add('KUGOU_API_GUID=${device['guid']}');
          if (device['serverDev'] != null) authParts.add('KUGOU_API_DEV=${device['serverDev']}');
          if (device['mac'] != null) authParts.add('KUGOU_API_MAC=${device['mac']}');
        }

        if (authParts.isNotEmpty) {
          options.headers['Authorization'] = authParts.join(';');
        }

        options.queryParameters['t'] = DateTime.now().millisecondsSinceEpoch;

        debugPrint('--> ${options.method} ${options.uri}');
        debugPrint('Headers: ${options.headers}');
        debugPrint('Params: ${options.queryParameters}');
        if (options.data != null) debugPrint('Body: ${options.data}');
        
        return handler.next(options);
      },
      onResponse: (response, handler) {
        debugPrint('<-- ${response.statusCode} ${response.requestOptions.uri}');
        return handler.next(response);
      },
      onError: (err, handler) {
        debugPrint('<-- ERROR ${err.response?.statusCode} ${err.requestOptions.uri}');
        debugPrint('Message: ${err.message}');
        if (err.response?.data != null) debugPrint('Error Body: ${err.response?.data}');
        return handler.next(err);
      },
    ));

  static Future<Map<String, dynamic>?> registerDevice() async {
    try {
      final response = await _dio.get('/register/dev', queryParameters: {'register': 'true'});
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
        return data.map((json) => Song.fromJson(json)).toList();
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

  static Future<String?> getSongUrl(String hash, {String quality = ''}) async {
    try {
      final params = <String, dynamic>{'hash': hash};
      if (quality.isNotEmpty) {
        params['quality'] = quality;
      }
      final response = await _dio.get('/song/url', queryParameters: params);
      if (response.data['status'] == 1) {
        return response.data['data']['url'];
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  static Future<List<Song>> getNewSongs() async {
    try {
      final response = await _dio.get('/top/song');
      if (response.data['status'] == 1) {
        List data = response.data['data'] ?? [];
        return data.map((json) => Song.fromJson(json)).toList();
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
      return [];
    } catch (e) {
      return [];
    }
  }

  static Future<List<Song>> getRankSongs(int rankId) async {
    try {
      final response = await _dio.get('/rank/info', queryParameters: {
        'rankid': rankId,
      });
      if (response.data['status'] == 1) {
        List data = response.data['data']['songs']['list'] ?? [];
        return data.map((json) => Song.fromJson(json)).toList();
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
        List data = response.data['data']['list'] ?? [];
        return data.map((json) => Playlist.fromJson(json)).toList();
      }
      return [];
    } catch (e) {
      return [];
    }
  }

  static Future<List<Song>> getPlaylistSongs(int id) async {
    try {
      final response = await _dio.get('/playlist/info', queryParameters: {
        'specialid': id,
      });
      if (response.data['status'] == 1) {
        List data = response.data['data']['songs']['list'] ?? [];
        return data.map((json) => Song.fromJson(json)).toList();
      }
      return [];
    } catch (e) {
      return [];
    }
  }

  static Future<Map<String, dynamic>?> searchLyric(String hash) async {
    try {
      final response = await _dio.get('/search/lyric', queryParameters: {
        'hash': hash,
      });
      if (response.data['status'] == 1 && response.data['data'] != null) {
        return response.data['data'];
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  static Future<String?> getLyric(String id, String accesskey) async {
    try {
      final response = await _dio.get('/lyric', queryParameters: {
        'id': id,
        'accesskey': accesskey,
        'decode': 'true',
      });
      if (response.data['status'] == 1) {
        return response.data['data']['lyric'];
      }
      return null;
    } catch (e) {
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
        List data = response.data['data']['info'] ?? [];
        return data.map((json) => Song.fromJson(json)).toList();
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
        List data = response.data['data']['info'] ?? [];
        return data.map((json) => Song.fromJson(json)).toList();
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
        return response.data['data']['info'] ?? {};
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

  static Future<Map<String, dynamic>?> loginCellphone(String mobile, String code) async {
    try {
      final response = await _dio.get('/login/cellphone', queryParameters: {'mobile': mobile, 'code': code});
      if (response.data['status'] == 1) return response.data['data'];
      return null;
    } catch (e) {
      return null;
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
        List data = response.data['data']['list'] ?? [];
        return data
            .where((item) => item['info'] != null)
            .map((item) => Song.fromJson(item['info']))
            .toList();
      }
      return [];
    } catch (e) {
      return [];
    }
  }

  static Future<bool> uploadPlayHistory(int mixsongid) async {
    try {
      final response = await _dio.get('/playhistory/upload', queryParameters: {'mxid': mixsongid});
      return response.data['status'] == 1;
    } catch (e) {
      return false;
    }
  }

  static Future<List<Song>> getUserCloud({int page = 1, int pagesize = 30}) async {
    try {
      final response = await _dio.get('/user/cloud', queryParameters: {'page': page, 'pagesize': pagesize});
      if (response.data['status'] == 1) {
        List data = response.data['data']['list'] ?? [];
        return data.map((json) => Song.fromJson(json)).toList();
      }
      return [];
    } catch (e) {
      return [];
    }
  }

  // --- Playlist ---
  static Future<List<Map<String, dynamic>>> getUserPlaylists({int page = 1, int pagesize = 30}) async {
    try {
      final response = await _dio.get('/user/playlist', queryParameters: {'page': page, 'pagesize': pagesize});
      if (response.data['status'] == 1) {
        List data = response.data['data']['info'] ?? [];
        return data.cast<Map<String, dynamic>>();
      }
      return [];
    } catch (e) {
      return [];
    }
  }

  static Future<bool> addPlaylist(String name, {int isPri = 0, int type = 0, int? listCreateUserid, int? listCreateListid}) async {
    try {
      final params = {
        'name': name,
        'is_pri': isPri,
        'type': type,
      };
      if (listCreateUserid != null) params['list_create_userid'] = listCreateUserid;
      if (listCreateListid != null) params['list_create_listid'] = listCreateListid;

      final response = await _dio.get('/playlist/add', queryParameters: params);
      return response.data['status'] == 1;
    } catch (e) {
      return false;
    }
  }

  static Future<bool> copyPlaylist(int playlistId, String name, {bool isPrivate = false}) async {
    return addPlaylist(
      name,
      isPri: isPrivate ? 1 : 0,
      type: 8, // Type 8 indicates copied/imported playlist
      listCreateListid: playlistId,
    );
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
      if (response.data['status'] == 1) {
        List data = response.data['data']['list'] ?? [];
        return data.map((json) => Playlist.fromJson(json)).toList();
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
      if (response.data['status'] == 1) {
        List data = response.data['data']['song_list'] ?? [];
        return data.map((json) {
          return Song.fromJson({
            ...json,
            'songname': json['filename'] ?? json['songname'],
            'timelen': (json['time_length'] ?? 0) * 1000, // legacy uses seconds?
          });
        }).toList();
      }
      return [];
    } catch (e) {
      return [];
    }
  }

  static Future<List<Map<String, dynamic>>> getTopIP() async {
    try {
      final response = await _dio.get('/top/ip');
      if (response.data['status'] == 1) {
        List data = response.data['data']['list'] ?? [];
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

  // --- Song Expanded ---
  static Future<Map<String, dynamic>> getSongPrivilege(String hash) async {
    try {
      final response = await _dio.get('/privilege/lite', queryParameters: {'hash': hash});
      if (response.data['status'] == 1) return response.data['data'] ?? {};
      return {};
    } catch (e) {
      return {};
    }
  }
}