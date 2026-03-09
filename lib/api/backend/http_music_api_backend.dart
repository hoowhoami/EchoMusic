import 'package:dio/dio.dart';

import '../../models/playlist.dart';
import '../../models/song.dart';
import '../../utils/logger.dart';
import '../transport/music_transport.dart';
import 'music_api_backend.dart';

class HttpMusicApiBackend extends MusicApiBackend {
  HttpMusicApiBackend({required MusicTransport Function() transportProvider})
    : _transportProvider = transportProvider;

  final MusicTransport Function() _transportProvider;

  Future<Response<dynamic>> _get(
    String path, {
    Map<String, dynamic>? queryParameters,
    Options? options,
  }) {
    return _transportProvider().get(
      path,
      queryParameters: queryParameters,
      options: options,
    );
  }

  @override
  Future<Map<String, dynamic>?> registerDevice() async {
    try {
      final response = await _get(
        '/register/dev',
        options: Options(extra: {'skipAuth': true}),
      );
      if (response.data['status'] == 1) {
        return response.data['data'];
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  @override
  Future<List<Song>> search(
    String keywords, {
    int page = 1,
    int pagesize = 30,
    String type = 'song',
  }) async {
    try {
      final response = await _get(
        '/search',
        queryParameters: {
          'keywords': keywords,
          'page': page,
          'pagesize': pagesize,
          'type': type,
        },
      );
      if (response.data['status'] == 1) {
        final List data = response.data['data']['lists'] ?? [];
        return data.map((json) => Song.fromSearchJson(json)).toList();
      }
      return [];
    } catch (_) {
      return [];
    }
  }

  @override
  Future<Map<String, dynamic>> getSearchResult(
    String keywords, {
    String type = 'song',
    int page = 1,
    int pagesize = 30,
  }) async {
    try {
      final response = await _get(
        '/search',
        queryParameters: {
          'keywords': keywords,
          'page': page,
          'pagesize': pagesize,
          'type': type,
        },
      );
      return response.data;
    } catch (_) {
      return {};
    }
  }

  @override
  Future<Map<String, dynamic>?> getSongUrl(
    String hash, {
    String quality = '',
  }) async {
    try {
      final params = <String, dynamic>{'hash': hash};
      if (quality.isNotEmpty) {
        params['quality'] = quality;
      }
      final response = await _get('/song/url', queryParameters: params);

      if (response.data != null) {
        final status = response.data['status'];
        final payload = response.data['data'] ?? response.data;
        final urlData = payload['url'];

        String? url;
        if (urlData is List && urlData.isNotEmpty) {
          url = urlData[0].toString();
        } else if (urlData is String) {
          url = urlData;
        }

        return {'url': url, 'status': status};
      }
      return null;
    } catch (e) {
      LoggerService.e('getSongUrl error: $e');
      return null;
    }
  }

  @override
  Future<String?> getCloudSongUrl(String hash) async {
    try {
      final response = await _get(
        '/user/cloud/url',
        queryParameters: {'hash': hash},
      );
      if (response.data['status'] == 1) {
        return response.data['data']?['url'];
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  @override
  Future<List<Map<String, dynamic>>> getSongPrivilege(
    String hash, {
    String? albumId,
  }) async {
    try {
      final params = {'hash': hash};
      if (albumId != null && albumId != '0' && albumId.isNotEmpty) {
        params['album_id'] = albumId;
      }

      final response = await _get('/privilege/lite', queryParameters: params);
      if (response.data['status'] == 1) {
        final List data = response.data['data'] ?? [];
        return data.cast<Map<String, dynamic>>();
      }
      return [];
    } catch (e) {
      LoggerService.e('getSongPrivilege error: $e');
      return [];
    }
  }

  @override
  Future<Map<String, dynamic>> getSongRanking(dynamic albumAudioId) async {
    try {
      final response = await _get(
        '/song/ranking',
        queryParameters: {'album_audio_id': albumAudioId},
      );
      return response.data;
    } catch (_) {
      return {};
    }
  }

  @override
  Future<Map<String, dynamic>> getSongRankingFilter(
    dynamic albumAudioId, {
    int page = 1,
    int pagesize = 30,
  }) async {
    try {
      final response = await _get(
        '/song/ranking/filter',
        queryParameters: {
          'album_audio_id': albumAudioId,
          'page': page,
          'pagesize': pagesize,
        },
      );
      return response.data;
    } catch (_) {
      return {};
    }
  }

  @override
  Future<Map<String, dynamic>> getFavoriteCount(String mixSongIds) async {
    try {
      final response = await _get(
        '/favorite/count',
        queryParameters: {'mixsongids': mixSongIds},
      );
      return response.data;
    } catch (_) {
      return {};
    }
  }

  @override
  Future<Map<String, dynamic>> getCommentCount(
    String hash, {
    String? specialId,
  }) async {
    try {
      final params = {'hash': hash};
      if (specialId != null) {
        params['special_id'] = specialId;
      }
      final response = await _get('/comment/count', queryParameters: params);
      return response.data;
    } catch (_) {
      return {};
    }
  }

  @override
  Future<Map<String, dynamic>> getMusicComments(
    dynamic mixSongId, {
    int page = 1,
    int pagesize = 30,
    int sort = 2,
    bool showClassify = false,
    bool showHotwordList = false,
  }) async {
    try {
      final response = await _get(
        '/comment/music',
        queryParameters: {
          'mixsongid': mixSongId,
          'page': page,
          'pagesize': pagesize,
          'show_classify': showClassify ? 1 : 0,
          'show_hotword_list': showHotwordList ? 1 : 0,
          'sort': sort,
        },
      );
      return response.data;
    } catch (_) {
      return {};
    }
  }

  @override
  Future<Map<String, dynamic>> getMusicClassifyComments(
    dynamic mixSongId,
    int typeId, {
    int page = 1,
    int pagesize = 30,
    int sort = 2,
  }) async {
    try {
      final response = await _get(
        '/comment/music/classify',
        queryParameters: {
          'mixsongid': mixSongId,
          'type_id': typeId,
          'page': page,
          'pagesize': pagesize,
          'sort': sort,
        },
      );
      return response.data;
    } catch (_) {
      return {};
    }
  }

  @override
  Future<Map<String, dynamic>> getMusicHotwordComments(
    dynamic mixSongId,
    String hotWord, {
    int page = 1,
    int pagesize = 30,
    int sort = 2,
  }) async {
    try {
      final response = await _get(
        '/comment/music/hotword',
        queryParameters: {
          'mixsongid': mixSongId,
          'hot_word': hotWord,
          'page': page,
          'pagesize': pagesize,
          'sort': sort,
        },
      );
      return response.data;
    } catch (_) {
      return {};
    }
  }

  @override
  Future<List<Song>> getNewSongs() async {
    try {
      final response = await _get('/top/song');
      if (response.data['status'] == 1) {
        final List data = response.data['data'] ?? [];
        return data.map((json) => Song.fromTopSongJson(json)).toList();
      }
      return [];
    } catch (_) {
      return [];
    }
  }

  @override
  Future<List<Map<String, dynamic>>> getRanks() async {
    try {
      final response = await _get('/rank/list');
      if (response.data['status'] == 1) {
        final List data = response.data['data']['info'] ?? [];
        return data.cast<Map<String, dynamic>>();
      }
      LoggerService.w('getRanks status != 1: ${response.data}');
      return [];
    } catch (e) {
      LoggerService.e('getRanks error: $e');
      return [];
    }
  }

  @override
  Future<List<Map<String, dynamic>>> getRankTop() async {
    try {
      final response = await _get('/rank/top');
      if (response.data['status'] == 1) {
        final List data =
            response.data['data']?['list'] ?? response.data['list'] ?? [];
        return data.cast<Map<String, dynamic>>();
      }
      return [];
    } catch (_) {
      return [];
    }
  }

  @override
  Future<List<Song>> getRankSongs(int rankId) async {
    try {
      final response = await _get(
        '/rank/audio',
        queryParameters: {'rankid': rankId, 'pagesize': 100},
      );
      if (response.data['status'] == 1) {
        final rawData = response.data['data'];
        List? list;
        if (rawData is Map) {
          list =
              rawData['list'] ??
              rawData['info'] ??
              rawData['songlist'] ??
              rawData['songs']?['list'];
        } else if (rawData is List) {
          list = rawData;
        }

        if (list != null) {
          return list.map((json) => Song.fromRankJson(json)).toList();
        }
      }
      return [];
    } catch (_) {
      return [];
    }
  }

  @override
  Future<List<Playlist>> getRecommendPlaylists() async {
    try {
      final response = await _get('/playlist/recommend');
      if (response.data['status'] == 1) {
        final List data =
            response.data['data']['list'] ??
            response.data['data']['special_list'] ??
            [];
        return data.map((json) => Playlist.fromSpecialPlaylist(json)).toList();
      }
      return [];
    } catch (_) {
      return [];
    }
  }

  @override
  Future<Map<String, dynamic>?> getPlaylistDetail(String ids) async {
    try {
      final response = await _get(
        '/playlist/detail',
        queryParameters: {'ids': ids},
      );
      if (response.data['status'] == 1) {
        final List data = response.data['data'] ?? [];
        return data.isNotEmpty ? data[0] : null;
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  @override
  Future<Map<String, dynamic>> getPlaylistTrackAll(
    String id, {
    int page = 1,
    int pagesize = 30,
  }) async {
    try {
      final response = await _get(
        '/playlist/track/all',
        queryParameters: {'id': id, 'page': page, 'pagesize': pagesize},
      );
      return response.data ?? {};
    } catch (_) {
      return {};
    }
  }

  @override
  Future<Map<String, dynamic>> getPlaylistTrackAllNew(
    int listid, {
    int page = 1,
    int pagesize = 200,
  }) async {
    try {
      final response = await _get(
        '/playlist/track/all/new',
        queryParameters: {'listid': listid, 'page': page, 'pagesize': pagesize},
      );
      return response.data ?? {};
    } catch (_) {
      return {};
    }
  }

  @override
  Future<Map<String, dynamic>?> searchLyric(String hash) async {
    try {
      final response = await _get(
        '/search/lyric',
        queryParameters: {'hash': hash},
      );
      if (response.data != null &&
          (response.data['status'] == 1 || response.data['status'] == 200)) {
        return response.data;
      }
      return null;
    } catch (e) {
      LoggerService.e('searchLyric Error: $e');
      return null;
    }
  }

  @override
  Future<Map<String, dynamic>?> getLyric(String id, String accesskey) async {
    try {
      final response = await _get(
        '/lyric',
        queryParameters: {
          'id': id,
          'accesskey': accesskey,
          'decode': 'true',
          'fmt': 'krc',
        },
      );
      if (response.data != null) {
        final data = response.data['data'] ?? response.data;
        if (response.data['status'] == 1 ||
            response.data['status'] == 200 ||
            data['decodeContent'] != null) {
          return data is Map ? Map<String, dynamic>.from(data) : null;
        }
      }
      return null;
    } catch (e) {
      LoggerService.e('getLyric Error: $e');
      return null;
    }
  }

  @override
  Future<Map<String, dynamic>?> getSingerDetail(int id) async {
    try {
      final response = await _get(
        '/artist/detail',
        queryParameters: {'id': id},
      );
      if (response.data['status'] == 1) {
        return response.data['data'];
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  @override
  Future<List<Song>> getSingerSongs(
    int id, {
    int page = 1,
    int pagesize = 200,
    String sort = 'hot',
  }) async {
    try {
      final response = await _get(
        '/artist/audios',
        queryParameters: {
          'id': id,
          'page': page,
          'pagesize': pagesize,
          'sort': sort,
        },
      );
      if (response.data['status'] == 1) {
        final rawData = response.data['data'];
        final List data = rawData is List
            ? rawData
            : (rawData['info'] ?? rawData['list'] ?? []);
        return data.map((json) => Song.fromArtistSongJson(json)).toList();
      }
      return [];
    } catch (_) {
      return [];
    }
  }

  @override
  Future<bool> followSinger(int id) async {
    try {
      final response = await _get(
        '/artist/follow',
        queryParameters: {'id': id},
      );
      return response.data['status'] == 1;
    } catch (_) {
      return false;
    }
  }

  @override
  Future<bool> unfollowSinger(int id) async {
    try {
      final response = await _get(
        '/artist/unfollow',
        queryParameters: {'id': id},
      );
      return response.data['status'] == 1;
    } catch (_) {
      return false;
    }
  }

  @override
  Future<Map<String, dynamic>?> getAlbumDetail(int id) async {
    try {
      final response = await _get('/album/detail', queryParameters: {'id': id});
      if (response.data['status'] == 1) {
        final data = response.data['data'];
        if (data is List && data.isNotEmpty) {
          return data[0];
        }
        if (data is Map<String, dynamic>) {
          return data;
        }
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  @override
  Future<List<Song>> getAlbumSongs(
    int id, {
    int page = 1,
    int pagesize = 50,
  }) async {
    try {
      final response = await _get(
        '/album/songs',
        queryParameters: {'id': id, 'page': page, 'pagesize': pagesize},
      );
      if (response.data['status'] == 1) {
        final rawData = response.data['data'];
        final List data = rawData is List
            ? rawData
            : (rawData['songs'] ?? rawData['info'] ?? rawData['list'] ?? []);
        return data.map((json) => Song.fromAlbumJson(json)).toList();
      }
      return [];
    } catch (_) {
      return [];
    }
  }

  @override
  Future<Map<String, dynamic>> getAlbumTop() async {
    try {
      final response = await _get('/top/album');
      if (response.data['status'] == 1) {
        return response.data['data'] ?? {};
      }
      return {};
    } catch (_) {
      return {};
    }
  }

  @override
  Future<bool> captchaSent(String mobile) async {
    try {
      final response = await _get(
        '/captcha/sent',
        queryParameters: {'mobile': mobile},
      );
      return response.data['status'] == 1;
    } catch (_) {
      return false;
    }
  }

  @override
  Future<Map<String, dynamic>> loginCellphone(
    String mobile,
    String code, {
    int? userid,
  }) async {
    try {
      final queryParams = {'mobile': mobile, 'code': code};
      if (userid != null) {
        queryParams['userid'] = userid.toString();
      }
      final response = await _get(
        '/login/cellphone',
        queryParameters: queryParams,
      );
      return response.data;
    } on DioException catch (e) {
      if (e.response?.data != null) {
        return e.response!.data is Map
            ? e.response!.data
            : {'status': 0, 'error': e.message};
      }
      return {'status': 0, 'error': e.message};
    } catch (e) {
      return {'status': 0, 'error': e.toString()};
    }
  }

  @override
  Future<Map<String, dynamic>?> loginQrKey() async {
    try {
      final response = await _get('/login/qr/key');
      if (response.data != null &&
          response.data['status'] == 1 &&
          response.data['data'] != null) {
        final data = response.data['data'];
        if (data['qrcode'] != null) {
          return {'key': data['qrcode'], 'qrcode_url': data['qrcode_img']};
        }
        if (data['key'] != null) {
          return data;
        }
        return data;
      }

      LoggerService.w('loginQrKey: 无法解析响应数据');
      return null;
    } catch (e) {
      LoggerService.e('loginQrKey error: $e');
      return null;
    }
  }

  @override
  Future<Map<String, dynamic>?> loginQrCreate(String key) async {
    try {
      final response = await _get(
        '/login/qr/create',
        queryParameters: {'key': key, 'qrimg': 'true'},
      );

      if (response.data != null) {
        if (response.data['code'] == 200 && response.data['data'] != null) {
          final data = response.data['data'];
          if (data['base64'] != null || data['url'] != null) {
            return {'qrcode_url': data['base64'] ?? data['url']};
          }
        }

        if (response.data['status'] == 1 && response.data['data'] != null) {
          return response.data['data'];
        }

        if (response.data['qrcode_url'] != null) {
          return response.data;
        }
      }
      LoggerService.w('loginQrCreate: 无法解析响应数据');
      return null;
    } catch (e) {
      LoggerService.e('loginQrCreate error: $e');
      return null;
    }
  }

  @override
  Future<Map<String, dynamic>?> loginQrCheck(String key) async {
    try {
      final response = await _get(
        '/login/qr/check',
        queryParameters: {'key': key},
      );
      return response.data;
    } catch (_) {
      return null;
    }
  }

  @override
  Future<Map<String, dynamic>?> loginWxCreate() async {
    try {
      final response = await _get('/login/wx/create');
      return response.data;
    } catch (e) {
      LoggerService.e('loginWxCreate error: $e');
      return null;
    }
  }

  @override
  Future<dynamic> loginWxCheck(String uuid) async {
    try {
      final response = await _get(
        '/login/wx/check',
        queryParameters: {
          'uuid': uuid,
          'timestamp': DateTime.now().millisecondsSinceEpoch,
        },
        options: Options(receiveTimeout: const Duration(seconds: 60)),
      );
      return response.data;
    } catch (e) {
      LoggerService.w(
        'loginWxCheck local failed, trying direct WeChat fallback: $e',
      );
      try {
        final fallbackDio = Dio(
          BaseOptions(
            connectTimeout: const Duration(seconds: 10),
            receiveTimeout: const Duration(seconds: 60),
          ),
        );
        final response = await fallbackDio.get(
          'https://long.open.weixin.qq.com/connect/l/qrconnect',
          queryParameters: {
            'f': 'json',
            'uuid': uuid,
            '_': DateTime.now().millisecondsSinceEpoch,
          },
        );
        return response.data;
      } catch (e2) {
        LoggerService.e('loginWxCheck all failed: $e2');
        return null;
      }
    }
  }

  @override
  Future<Map<String, dynamic>> loginOpenPlat(String code) async {
    try {
      final response = await _get(
        '/login/openplat',
        queryParameters: {'code': code},
      );
      return response.data;
    } catch (e) {
      LoggerService.e('loginOpenPlat error: $e');
      return {'status': 0, 'error': e.toString()};
    }
  }

  @override
  Future<Map<String, dynamic>?> userDetail() async {
    try {
      final response = await _get('/user/detail');
      if (response.data['status'] == 1) {
        return response.data['data'];
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  @override
  Future<Map<String, dynamic>?> userVipDetail() async {
    try {
      final response = await _get('/user/vip/detail');
      if (response.data['status'] == 1) {
        return response.data['data'];
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  @override
  Future<List<Map<String, dynamic>>> getUserFollow() async {
    try {
      final response = await _get('/user/follow');
      if (response.data['status'] == 1) {
        final List data = response.data['data']['lists'] ?? [];
        return data.cast<Map<String, dynamic>>();
      }
      return [];
    } catch (_) {
      return [];
    }
  }

  @override
  Future<Map<String, dynamic>> getUserPlayHistory({String? bp}) async {
    try {
      final response = await _get(
        '/user/history',
        queryParameters: bp != null ? {'bp': bp} : {},
      );
      if (response.data['status'] == 1) {
        final payload = response.data['data'] ?? {};
        final List data = payload['list'] ?? payload['songs'] ?? [];
        return {
          'songs': data
              .where((item) => item['info'] != null)
              .map((item) => Song.fromPlaylistJson(item['info']))
              .toList(),
          'bp': payload['bp'],
          'has_more': payload['has_more'] ?? data.isNotEmpty,
        };
      }
      return {'songs': <Song>[], 'bp': null, 'has_more': false};
    } catch (_) {
      return {'songs': <Song>[], 'bp': null, 'has_more': false};
    }
  }

  @override
  Future<bool> uploadPlayHistory(int mixSongId) async {
    try {
      final response = await _get(
        '/playhistory/upload',
        queryParameters: {'mxid': mixSongId},
      );
      return response.data['status'] == 1;
    } catch (_) {
      return false;
    }
  }

  @override
  Future<Map<String, dynamic>> getUserCloud({
    int page = 1,
    int pagesize = 30,
  }) async {
    try {
      final response = await _get(
        '/user/cloud',
        queryParameters: {'page': page, 'pagesize': pagesize},
      );
      if (response.data['status'] == 1) {
        final payload = response.data['data'] ?? {};
        final List data = payload['list'] ?? [];
        return {
          'songs': data.map((json) => Song.fromCloudJson(json)).toList(),
          'count': payload['list_count'] ?? 0,
          'capacity': payload['max_size'] ?? 0,
          'available': payload['availble_size'] ?? 0,
        };
      }
      return {'songs': <Song>[], 'count': 0, 'capacity': 0, 'available': 0};
    } catch (_) {
      return {'songs': <Song>[], 'count': 0, 'capacity': 0, 'available': 0};
    }
  }

  @override
  Future<Map<String, dynamic>> getUserPlaylistsRaw({
    int page = 1,
    int pagesize = 30,
  }) async {
    try {
      final response = await _get(
        '/user/playlist',
        queryParameters: {'page': page, 'pagesize': pagesize},
      );
      return response.data ?? {};
    } catch (e) {
      return {'status': 0, 'error': e.toString()};
    }
  }

  @override
  Future<bool> addPlaylist(
    String name, {
    int isPri = 0,
    int type = 0,
    int? listCreateUserid,
    int? listCreateListid,
    String? listCreateGid,
    int source = 1,
  }) async {
    try {
      final params = {
        'name': name,
        'is_pri': isPri,
        'type': type,
        'source': source,
      };
      if (listCreateUserid != null) {
        params['list_create_userid'] = listCreateUserid;
      }
      if (listCreateListid != null) {
        params['list_create_listid'] = listCreateListid;
      }
      if (listCreateGid != null) {
        params['list_create_gid'] = listCreateGid;
      }

      final response = await _get('/playlist/add', queryParameters: params);
      return response.data['status'] == 1;
    } catch (_) {
      return false;
    }
  }

  @override
  Future<bool> deletePlaylist(int listid) async {
    try {
      final response = await _get(
        '/playlist/del',
        queryParameters: {'listid': listid},
      );
      return response.data['status'] == 1;
    } catch (_) {
      return false;
    }
  }

  @override
  Future<bool> addPlaylistTrack(dynamic listid, String data) async {
    try {
      final response = await _get(
        '/playlist/tracks/add',
        queryParameters: {'listid': listid, 'data': data},
      );
      return response.data['status'] == 1;
    } catch (_) {
      return false;
    }
  }

  @override
  Future<bool> deletePlaylistTrack(dynamic listid, String fileids) async {
    try {
      final response = await _get(
        '/playlist/tracks/del',
        queryParameters: {'listid': listid, 'fileids': fileids},
      );
      return response.data['status'] == 1;
    } catch (_) {
      return false;
    }
  }

  @override
  Future<List<Map<String, dynamic>>> getPlaylistCategory() async {
    try {
      final response = await _get('/playlist/tags');
      if (response.data['status'] == 1) {
        final List data = response.data['data'] ?? [];
        return data.cast<Map<String, dynamic>>();
      }
      return [];
    } catch (_) {
      return [];
    }
  }

  @override
  Future<List<Playlist>> getPlaylistByCategory(
    String categoryId, {
    int withsong = 0,
    int withtag = 1,
  }) async {
    try {
      final response = await _get(
        '/top/playlist',
        queryParameters: {
          'category_id': categoryId,
          'withsong': withsong,
          'withtag': withtag,
        },
      );
      final root = response.data is Map ? response.data : {};
      if (root['status'] == 1) {
        final List data =
            root['data']?['special_list'] ??
            root['data']?['list'] ??
            root['special_list'] ??
            root['list'] ??
            [];
        return data.map((json) => Playlist.fromSpecialPlaylist(json)).toList();
      }
      return [];
    } catch (_) {
      return [];
    }
  }

  @override
  Future<String> getSearchDefault() async {
    try {
      final response = await _get('/search/default');
      if (response.data['status'] == 1) {
        final data = response.data['data'];
        return data['keyword'] ??
            data['show_keyword'] ??
            data['fallback'] ??
            '';
      }
      return '';
    } catch (_) {
      return '';
    }
  }

  @override
  Future<List<String>> getSearchHot() async {
    try {
      final response = await _get('/search/hot');
      if (response.data['status'] == 1) {
        final List list = response.data['data']['list'] ?? [];
        if (list.isNotEmpty) {
          final List keywords = list[0]['keywords'] ?? [];
          return keywords.map((e) => e['keyword'].toString()).toList();
        }
      }
      return [];
    } catch (_) {
      return [];
    }
  }

  @override
  Future<List<Map<String, dynamic>>> getSearchHotCategorized() async {
    try {
      final response = await _get('/search/hot');
      if (response.data['status'] == 1) {
        final List data = response.data['data']['list'] ?? [];
        return data.cast<Map<String, dynamic>>();
      }
      return [];
    } catch (_) {
      return [];
    }
  }

  @override
  Future<List<Map<String, dynamic>>> getSearchSuggest(String keywords) async {
    try {
      final response = await _get(
        '/search/suggest',
        queryParameters: {'keywords': keywords},
      );
      if (response.data['status'] == 1) {
        return (response.data['data'] as List).cast<Map<String, dynamic>>();
      }
      return [];
    } catch (_) {
      return [];
    }
  }

  @override
  Future<List<Song>> getEverydayRecommend() async {
    try {
      final response = await _get('/everyday/recommend');
      final root = response.data is Map ? response.data : {};
      if (root['status'] == 1) {
        final List data =
            root['data']?['song_list'] ??
            root['song_list'] ??
            root['data'] ??
            [];
        return data.map((json) => Song.fromTopSongJson(json)).toList();
      }
      return [];
    } catch (_) {
      return [];
    }
  }

  @override
  Future<List<Map<String, dynamic>>> getTopIP() async {
    try {
      final response = await _get('/top/ip');
      final root = response.data is Map ? response.data : {};
      if (root['status'] == 1) {
        final List data =
            root['data']?['list'] ?? root['data'] ?? root['list'] ?? [];
        return data.cast<Map<String, dynamic>>();
      }
      return [];
    } catch (_) {
      return [];
    }
  }

  @override
  Future<List<Map<String, dynamic>>> getIPData(
    int id, {
    String type = '',
    int page = 1,
    int pagesize = 30,
  }) async {
    try {
      final response = await _get(
        '/ip',
        queryParameters: {
          'id': id,
          'type': type,
          'page': page,
          'pagesize': pagesize,
        },
      );
      if (response.data['status'] == 1) {
        return (response.data['data']['list'] as List)
            .cast<Map<String, dynamic>>();
      }
      return [];
    } catch (_) {
      return [];
    }
  }

  @override
  Future<List<Map<String, dynamic>>> getTopPlaylistByIP(
    int id, {
    int page = 1,
    int pagesize = 30,
  }) async {
    try {
      final response = await _get(
        '/ip/playlist',
        queryParameters: {'id': id, 'page': page, 'pagesize': pagesize},
      );
      if (response.data['status'] == 1) {
        return (response.data['data']['list'] as List)
            .cast<Map<String, dynamic>>();
      }
      return [];
    } catch (_) {
      return [];
    }
  }

  @override
  Future<List<Song>> getSongClimax(String hash) async {
    try {
      final response = await _get(
        '/song/climax',
        queryParameters: {'hash': hash},
      );
      if (response.data['status'] == 1) {
        final List data = response.data['data'] ?? [];
        return data.map((json) => Song.fromJson(json)).toList();
      }
      return [];
    } catch (_) {
      return [];
    }
  }

  @override
  Future<List<Map<String, dynamic>>> getSongClimaxRaw(String hash) async {
    try {
      final response = await _get(
        '/song/climax',
        queryParameters: {'hash': hash},
      );
      if (response.data['status'] == 1) {
        final List data = response.data['data'] ?? [];
        return data.cast<Map<String, dynamic>>();
      }
      return [];
    } catch (_) {
      return [];
    }
  }

  @override
  Future<bool> claimDayVip(String day) async {
    try {
      final response = await _get(
        '/youth/day/vip',
        queryParameters: {'receive_day': day},
      );
      return response.data['status'] == 1;
    } catch (_) {
      return false;
    }
  }

  @override
  Future<bool> upgradeDayVip() async {
    try {
      final response = await _get('/youth/day/vip/upgrade');
      return response.data['status'] == 1;
    } catch (_) {
      return false;
    }
  }

  @override
  Future<Map<String, dynamic>> getVipMonthRecord() async {
    try {
      final response = await _get('/youth/month/vip/record');
      if (response.data['status'] == 1) {
        return response.data['data'] ?? {};
      }
      return {};
    } catch (_) {
      return {};
    }
  }
}
