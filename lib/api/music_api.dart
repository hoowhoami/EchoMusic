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

        debugPrint('--> ${options.method} ${options.uri}');
        debugPrint('Headers: ${options.headers}');
        debugPrint('Params: ${options.queryParameters}');
        if (options.data != null) debugPrint('Body: ${options.data}');
        
        return handler.next(options);
      },
      onResponse: (response, handler) {
        debugPrint('<-- ${response.statusCode} ${response.requestOptions.uri}');
        debugPrint('Response: ${response.data}');
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

  static Future<List<Song>> search(String keywords, {int page = 1, int pagesize = 30}) async {
    try {
      final response = await _dio.get('/search', queryParameters: {
        'keywords': keywords,
        'page': page,
        'pagesize': pagesize,
        'type': 'song',
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

  static Future<String?> getSongUrl(String hash) async {
    try {
      final response = await _dio.get('/song/url', queryParameters: {
        'hash': hash,
      });
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
}