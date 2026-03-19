class Song {
  final String hash;
  final String name; // This will store the actual song title
  final String albumName;
  final String? albumId;
  final List<SingerInfo> singers;
  final int duration; // in seconds
  final String cover;
  final String? mvHash;
  final int mixSongId;
  final int? fileId;
  final int? privilege;
  final List<Map<String, dynamic>>? relateGoods;
  final String? source;
  final int? oldCpy; // 服务器收藏状态：1=已收藏可播放，0=未收藏
  final int? payType; // 付费类型：0=免费，2=需要购买，3=需要VIP

  Song({
    required this.hash,
    required this.name,
    required this.albumName,
    this.albumId,
    required this.singers,
    required this.duration,
    required this.cover,
    this.mvHash,
    required this.mixSongId,
    this.fileId,
    this.privilege,
    this.relateGoods,
    this.source,
    this.oldCpy,
    this.payType,
  });

  // For /top/song and /everyday/recommend
  factory Song.fromTopSongJson(Map<String, dynamic> json) {
    int parseInt(dynamic value) {
      if (value == null) return 0;
      if (value is int) return value;
      return int.tryParse(value.toString()) ?? 0;
    }

    int? parseOptionalInt(dynamic value) {
      if (value == null) return null;
      if (value is int) return value;
      return int.tryParse(value.toString());
    }

    var singersList = json['authors'] as List? ?? json['singerinfo'] as List? ?? [];
    List<SingerInfo> singers = singersList.map((i) => SingerInfo.fromJson(i)).toList();
    if (singers.isEmpty && (json['author_name'] != null || json['singername'] != null)) {
      singers = [SingerInfo(id: 0, name: (json['author_name'] ?? json['singername']).toString())];
    }

    String cover = json['album_sizable_cover'] ?? 
                   json['trans_param']?['union_cover'] ?? 
                   json['cover'] ?? '';
    cover = cover.replaceAll('{size}', '400');

    final privilegeValue =
        json.containsKey('privilege') ? parseOptionalInt(json['privilege']) : null;

    final relateGoods = <Map<String, dynamic>>[];
    if (json['hash_320'] != null) relateGoods.add({'hash': json['hash_320'], 'quality': '320'});
    if (json['hash_flac'] != null) relateGoods.add({'hash': json['hash_flac'], 'quality': 'flac'});
    if (json['hash_high'] != null) relateGoods.add({'hash': json['hash_high'], 'quality': 'high'});    

    return Song(
      hash: (json['hash'] ?? json['hash_128'] ?? json['FileHash'] ?? '').toString(),
      name: _processName((json['songname'] ?? json['filename'] ?? json['name'] ?? '').toString()),
      albumName: (json['album_name'] ?? json['albumname'] ?? '').toString(),
      albumId: (json['album_id'] ?? json['albumid'])?.toString(),
      singers: singers,
      duration: parseInt(json['time_length'] ?? 0) != 0 ? parseInt(json['time_length']) : parseInt(json['timelength'] ?? json['duration'] ?? 0) ~/ 1000,
      cover: cover,
      mvHash: (json['video_hash'] ?? json['mvhash'])?.toString(),
      mixSongId: parseInt(json['audio_id'] ?? json['album_audio_id'] ?? json['mixsongid'] ?? 0),
      privilege: privilegeValue,
      relateGoods: relateGoods,
      oldCpy: parseOptionalInt(json['old_cpy'] ?? json['media_old_cpy']),
      payType: parseOptionalInt(json['pay_type']),
    );
  }

  // For /playlist/track/all and history
  factory Song.fromPlaylistJson(Map<String, dynamic> json) {
    // 兼容处理：部分接口（如公共歌单）会将核心信息包装在 audio_info 中
    final audioInfo = json['audio_info'] ?? {};
    final hash = (json['hash'] ?? audioInfo['hash_128'] ?? audioInfo['hash'] ?? '').toString();

    int parseInt(dynamic value) {
      if (value == null) return 0;
      if (value is int) return value;
      return int.tryParse(value.toString()) ?? 0;
    }

    int? parseOptionalInt(dynamic value) {
      if (value == null) return null;
      if (value is int) return value;
      return int.tryParse(value.toString());
    }

    String rawName = (json['songname'] ??
            json['filename'] ??
            json['name'] ??
            json['audio_name'] ??
            audioInfo['songname'] ??
            audioInfo['filename'] ??
            audioInfo['name'] ??
            '')
        .toString();
    String singerName = (json['author_name'] ??
            json['singername'] ??
            json['singer'] ??
            audioInfo['author_name'] ??
            audioInfo['singername'] ??
            '')
        .toString();

    if (singerName.isEmpty && rawName.contains(' - ')) {
      singerName = rawName.split(' - ')[0];
    }

    String title = _processName(rawName);
    final extensions = ['.mp3', '.flac', '.wav', '.aac', '.m4a', '.ape'];
    for (final ext in extensions) {
      if (title.toLowerCase().endsWith(ext)) {
        title = title.substring(0, title.length - ext.length);
      }
      if (singerName.toLowerCase().endsWith(ext)) {
        singerName = singerName.substring(0, singerName.length - ext.length);
      }
    }

    var singersList = json['singerinfo'] as List? ?? json['authors'] as List? ?? [];
    List<SingerInfo> singers = singersList.map((i) => SingerInfo.fromJson(i)).toList();
    if (singers.isEmpty && singerName.isNotEmpty) {
      singers = [SingerInfo(id: 0, name: singerName)];
    }

    final albumInfo = json['albuminfo'] ?? json['album_info'] ?? {};
    final transParam = json['trans_param'] ?? {};
    String cover = (json['cover'] ??
            json['pic'] ??
            json['img'] ??
            json['album_sizable_cover'] ??
            audioInfo['img'] ??
            transParam['union_cover'] ??
            albumInfo['cover'] ??
            albumInfo['sizable_cover'] ??
            '')
        .toString();
    cover = cover.replaceAll('{size}', '400');

    int duration = parseInt(json['timelen'] ?? audioInfo['duration_128'] ?? audioInfo['duration'] ?? 0);

    final privilegeValue = json.containsKey('privilege')
        ? parseOptionalInt(json['privilege'])
        : (audioInfo.containsKey('privilege')
            ? parseOptionalInt(audioInfo['privilege'])
            : null);

    return Song(
      hash: hash,
      name: title,
      albumName: (json['albumname'] ?? json['album_name'] ?? albumInfo['name'] ?? albumInfo['album_name'] ?? '').toString(),
      albumId: (albumInfo['id'] ?? albumInfo['album_id'] ?? json['album_id'] ?? json['albumid'])?.toString(),
      singers: singers,
      duration: duration ~/ 1000,
      cover: cover,
      mvHash: (json['mvhash'] ?? json['video_hash'])?.toString(),
      mixSongId: parseInt(json['mixsongid'] ?? json['audio_id'] ?? audioInfo['audio_id'] ?? 0),
      fileId: json['fileid'] != null ? parseInt(json['fileid']) : null,
      privilege: privilegeValue,
      relateGoods: (json['relate_goods'] as List?)?.cast<Map<String, dynamic>>(),
      source: json['source']?.toString(),
      oldCpy: parseOptionalInt(json['media_old_cpy']),
      payType: parseOptionalInt((json['download'] as List?)?.first?['pay_type']),
    );
  }

  // For /user/cloud
  factory Song.fromCloudJson(Map<String, dynamic> json) {
    final audioInfo = json['audio_info'] ?? {};
    final albumInfo = json['album_info'] ?? {};
    
    int parseInt(dynamic value) {
      if (value == null) return 0;
      if (value is int) return value;
      return int.tryParse(value.toString()) ?? 0;
    }

    String rawName = (json['songname'] ?? json['filename'] ?? json['name'] ?? audioInfo['songname'] ?? '').toString();
    String singerName = (json['singername'] ?? json['author_name'] ?? json['singer'] ?? audioInfo['author_name'] ?? '').toString();
    String albumName = (json['albumname'] ?? json['album_name'] ?? albumInfo['album_name'] ?? '').toString();
    
    // Attempt to extract singer from rawName if singerName is empty
    if (singerName.isEmpty && rawName.contains(' - ')) {
      singerName = rawName.split(' - ')[0];
    }
    
    String title = _processName(rawName);

    // Clean up file extensions if present
    final extensions = ['.mp3', '.flac', '.wav', '.aac', '.m4a', '.ape'];
    for (var ext in extensions) {
      if (title.toLowerCase().endsWith(ext)) {
        title = title.substring(0, title.length - ext.length);
      }
      if (singerName.toLowerCase().endsWith(ext)) {
        singerName = singerName.substring(0, singerName.length - ext.length);
      }
    }

    if (singerName.isEmpty) singerName = '未知歌手';

    return Song(
      hash: (json['hash'] ?? audioInfo['hash'] ?? audioInfo['hash_128'] ?? '').toString(),
      name: title,
      albumName: albumName,
      albumId: (json['albumid'] ?? json['album_id'] ?? albumInfo['album_id'])?.toString(),
      singers: [SingerInfo(id: 0, name: singerName)],
      duration: parseInt(json['duration'] ?? json['timelen'] ?? audioInfo['duration'] ?? audioInfo['duration_128'] ?? 0) ~/
                (json.containsKey('timelen') || audioInfo.containsKey('duration_128') ? 1000 : 1),
      cover: (json['cover'] ?? json['pic'] ?? albumInfo['sizable_cover'] ?? '').toString(),
      mixSongId: parseInt(json['mixsongid'] ?? json['audio_id'] ?? audioInfo['audio_id'] ?? 0),
      source: 'cloud',
      oldCpy: null,
      payType: null,
    );
  }

  // Base/Fallback parsing
  factory Song.fromJson(Map<String, dynamic> json) {
    // If it looks like a playlist song
    if (json.containsKey('singerinfo')) return Song.fromPlaylistJson(json);
    // If it looks like a top song
    if (json.containsKey('authors')) return Song.fromTopSongJson(json);
    // Default to basic fromPlaylist style
    return Song.fromPlaylistJson(json);
  }

  // Specifically for Rank API results
  factory Song.fromRankJson(Map<String, dynamic> json) {
    final audioInfo = json['audio_info'] ?? {};
    final albumInfo = json['album_info'] ?? {};
    final transParam = json['trans_param'] ?? {};

    int parseInt(dynamic value) {
      if (value == null) return 0;
      if (value is int) return value;
      return int.tryParse(value.toString()) ?? 0;
    }

    int? parseOptionalInt(dynamic value) {
      if (value == null) return null;
      if (value is int) return value;
      return int.tryParse(value.toString());
    }

    String cover = albumInfo['sizable_cover'] ?? transParam['union_cover'] ?? '';
    cover = cover.replaceAll('{size}', '400');

    int duration = parseInt(audioInfo['duration_128'] ?? audioInfo['duration'] ?? 0) ~/ 1000;

    var singersList = json['authors'] as List? ?? [];
    List<SingerInfo> singers = singersList.map((i) => SingerInfo.fromJson(i)).toList();
    if (singers.isEmpty && json['author_name'] != null) {
      singers = [SingerInfo(id: 0, name: json['author_name'].toString())];
    }

    final privilegeValue = parseOptionalInt(json['privilege']) ?? parseOptionalInt(json['privilege_download']?['privilege']);

    final relateGoods = <Map<String, dynamic>>[];
    if (audioInfo['hash_320'] != null) relateGoods.add({'hash': audioInfo['hash_320'], 'quality': '320'});
    if (audioInfo['hash_flac'] != null) relateGoods.add({'hash': audioInfo['hash_flac'], 'quality': 'flac'});
    if (audioInfo['hash_high'] != null) relateGoods.add({'hash': audioInfo['hash_high'], 'quality': 'high'});

    return Song(
      hash: (audioInfo['hash_128'] ?? audioInfo['hash'] ?? '').toString(),
      name: _processName((json['songname'] ?? '').toString()),
      albumName: (albumInfo['album_name'] ?? '').toString(),
      albumId: json['album_id']?.toString(),
      singers: singers,
      duration: duration,
      cover: cover,
      mixSongId: parseInt(json['audio_id'] ?? 0),
      privilege: privilegeValue,
      relateGoods: relateGoods,
      oldCpy: parseOptionalInt(json['deprecated']?['old_cpy']),
      payType: parseOptionalInt(json['deprecated']?['pay_type']),
    );
  }

  // Specifically for Album songs API results
  factory Song.fromAlbumJson(Map<String, dynamic> json) {
    final base = json['base'] ?? {};
    final audioInfo = json['audio_info'] ?? {};
    final albumInfo = json['album_info'] ?? {};
    final transParam = json['trans_param'] ?? {};

    int parseInt(dynamic value) {
      if (value == null) return 0;
      if (value is int) return value;
      return int.tryParse(value.toString()) ?? 0;
    }

    int? parseOptionalInt(dynamic value) {
      if (value == null) return null;
      if (value is int) return value;
      return int.tryParse(value.toString());
    }

    String cover = json['pic'] ??
                  json['img'] ??
                  audioInfo['img'] ??
                  albumInfo['cover'] ??
                  transParam['union_cover'] ?? '';
    cover = cover.replaceAll('{size}', '400');

    int duration = parseInt(audioInfo['duration'] ?? 0) ~/ 1000;

    var singersList = json['authors'] as List? ?? [];
    List<SingerInfo> singers = singersList.map((i) => SingerInfo.fromJson(i)).toList();
    if (singers.isEmpty && base['author_name'] != null) {
      singers = [SingerInfo(id: 0, name: base['author_name'].toString())];
    }

    final relateGoods = <Map<String, dynamic>>[];
    if (audioInfo['hash_320'] != null) relateGoods.add({'hash': audioInfo['hash_320'], 'quality': '320'});
    if (audioInfo['hash_flac'] != null) relateGoods.add({'hash': audioInfo['hash_flac'], 'quality': 'flac'});
    if (audioInfo['hash_high'] != null) relateGoods.add({'hash': audioInfo['hash_high'], 'quality': 'high'});

    return Song(
      hash: (audioInfo['hash'] ?? '').toString(),
      name: _processName((base['audio_name'] ?? '').toString()),
      albumName: (albumInfo['album_name'] ?? '').toString(),
      albumId: base['album_id']?.toString(),
      singers: singers,
      duration: duration,
      cover: cover,
      relateGoods: relateGoods,
      mixSongId: parseInt(base['audio_id'] ?? 0),
      privilege: parseInt(json['privilege'] ?? json['copyright']?['privilege'] ??  0),
      oldCpy: parseOptionalInt(json['deprecated']?['old_cpy']),
      payType: parseOptionalInt(json['deprecated']?['pay_type']),
    );
  }

  // Specifically for Search API results
  factory Song.fromSearchJson(Map<String, dynamic> json) {
    final relateGoods = <Map<String, dynamic>>[];
    if (json['HQ'] != null) relateGoods.add({'hash': json['HQ']['Hash'], 'quality': '320'});
    if (json['SQ'] != null) relateGoods.add({'hash': json['SQ']['Hash'], 'quality': 'flac'});
    if (json['Res'] != null) relateGoods.add({'hash': json['Res']['Hash'], 'quality': 'high'});

    final singers = (json['Singers'] as List?)?.map((s) => SingerInfo.fromJson({
      'id': s['id'],
      'name': s['name'],
    })).toList() ?? [];

    final privilegeValue = json.containsKey('AlbumPrivilege')
        ? int.tryParse(json['AlbumPrivilege'].toString())
        : null;

    return Song(
      hash: (json['FileHash'] ?? '').toString(),
      name: _processName((json['SongName'] ?? json['FileName'] ?? '').toString()),
      albumName: (json['AlbumName'] ?? '').toString(),
      albumId: json['AlbumID']?.toString(),
      singers: singers,
      duration: int.tryParse((json['Duration'] ?? 0).toString()) ?? 0,
      cover: (json['Image'] ?? '').toString().replaceAll('{size}', '400'),
      mvHash: json['MVHash']?.toString(),
      mixSongId: int.tryParse((json['MixSongID'] ?? 0).toString()) ?? 0,
      fileId: int.tryParse((json['Audioid'] ?? 0).toString()),
      privilege: privilegeValue,
      relateGoods: relateGoods,
      oldCpy: json['OldCpy'] != null ? int.tryParse(json['OldCpy'].toString()) : null,
      payType: json['PayType'] != null ? int.tryParse(json['PayType'].toString()) : null,
    );
  }

  // Specifically for Artist Audios API results
  factory Song.fromArtistSongJson(int id, Map<String, dynamic> json) {
    final relateGoods = <Map<String, dynamic>>[];
    if (json['hash_320'] != null) relateGoods.add({'hash': json['hash_320'], 'quality': '320'});
    if (json['hash_flac'] != null) relateGoods.add({'hash': json['hash_flac'], 'quality': 'flac'});
    if (json['hash_high'] != null) relateGoods.add({'hash': json['hash_high'], 'quality': 'high'});

    return Song(
      hash: (json['hash'] ?? '').toString(),
      name: (json['audio_name'] ?? '').toString(),
      albumName: (json['album_name'] ?? '').toString(),
      albumId: json['album_id']?.toString(),
      singers: [SingerInfo(id: id, name: (json['author_name'] ?? '未知歌手').toString())],
      duration: (int.tryParse((json['timelength'] ?? 0).toString()) ?? 0) ~/ 1000,
      cover: (json['trans_param']?['union_cover'] ?? '').toString().replaceAll('{size}', '400'),
      mixSongId: int.tryParse((json['mixsongid'] ?? json['album_audio_id'] ?? 0).toString()) ?? 0,
      relateGoods: relateGoods,
      privilege: int.tryParse((json['privilege'] ?? 0).toString()),
      oldCpy: json['old_cpy'] != null ? int.tryParse(json['old_cpy'].toString()) : null,
      payType: json['pay_type'] != null ? int.tryParse(json['pay_type'].toString()) : null,
    );
  }

  // Helper to extract song title from "Singer - Title" format
  static String _processName(String rawName) {
    if (rawName.contains(' - ')) {
      final parts = rawName.split(' - ');
      if (parts.length > 1) {
        return parts[1];
      }
    }
    return rawName;
  }

  static String normalizeDisplayText(String rawText) {
    final normalized = rawText.replaceAll('_', ' ').replaceAll(RegExp(r'\s+'), ' ').trim();
    return normalized;
  }

  String get singerName => singers.isEmpty ? '未知歌手' : singers.map((s) => s.name).join(', ');

  String get displaySingerName => normalizeDisplayText(singerName);

  String get displayAlbumName => normalizeDisplayText(albumName);

  String get title => name; // name is already processed title

  bool get isVip => privilege == 10 && payType == 3;

  bool get isPaid => privilege == 10 && payType == 2;

  bool get isNoCopyright => privilege == 5;

  bool get isUnavailable => privilege == 40;

  // 播放判断逻辑
  // privilege == 5 (无版权) 需要 oldCpy == 1 (已收藏) 才能播放
  // privilege == 10 + payType == 2 (付费购买) 不能播放
  // privilege == 10 + payType == null (未知) 当作 VIP 处理，可以尝试播放
  bool get canPlay {
    if (isUnavailable) return false;
    if (isPaid) return false; // 需要付费购买，不能播放
    if (isNoCopyright) return oldCpy == 1; // 无版权歌曲需要已收藏
    return true;
  }

  bool get isPlayable => hash.isNotEmpty && canPlay;

  // 获取所有适用的标签（可能有多个）
  List<({String label, int color, String message})> get privilegeTags {
    final tags = <({String label, int color, String message})>[];

    if (isPaid) {
      tags.add((label: '付费', color: 0xFFEF4444, message: '需要购买')); // 红色
    }
    if (isVip) {
      tags.add((label: 'VIP', color: 0xFFF59E0B, message: '需要VIP')); // 橙色
    }
    if (!isPlayable && isNoCopyright) {
      tags.add((label: '版权', color: 0xFF8B5CF6, message: '无版权')); // 紫色
    }
    if (isUnavailable) {
      tags.add((label: '音源', color: 0xFF6B7280, message: '不可用')); // 灰色
    }

    return tags;
  }

  // 统一的不可用消息（只返回不可播放歌曲的消息）
  String? get unavailableMessage {
    if (isPlayable) return null;
    if (isPaid) return '需要购买';
    if (isNoCopyright) return '无版权';
    if (isUnavailable) return '不可用';
    return '暂无音源';
  }

  String get qualityTag {
    if (relateGoods == null || relateGoods!.isEmpty) return '';

    // 检查是否有 Hi-Res 品质
    if (relateGoods!.any((item) => item['quality'] == 'high' || item['level'] == 6)) {
      return 'Hi-Res';
    }

    // 检查是否有 FLAC/SQ 品质
    if (relateGoods!.any((item) => item['quality'] == 'flac' || item['level'] == 5)) {
      return 'SQ';
    }

    // 检查是否有 320kbps/HQ 品质
    if (relateGoods!.any((item) => item['quality'] == '320' || item['level'] == 4)) {
      return 'HQ';
    }

    return '';
  }

  bool isSameSong(Song other) {
    if (mixSongId != 0 && other.mixSongId != 0) {
      if (mixSongId == other.mixSongId) return true;
    }
    if (hash.isNotEmpty && other.hash.isNotEmpty) {
      if (hash.toLowerCase() == other.hash.toLowerCase()) return true;
    }
    return false;
  }

  Map<String, dynamic> toJson() {
    return {
      'hash': hash,
      'name': name,
      'songname': name,
      'album_name': albumName,
      'album_id': albumId,
      'albumid': albumId,
      'albuminfo': {
        'id': albumId,
        'album_id': albumId,
        'name': albumName,
        'album_name': albumName,
      },
      'singerinfo': singers.map((s) => s.toJson()).toList(growable: false),
      'timelen': duration * 1000,
      'cover': cover,
      'mixsongid': mixSongId,
      'audio_id': mixSongId,
      'mvhash': mvHash,
      'fileid': fileId,
      'privilege': privilege,
      'relate_goods': relateGoods,
      'source': source,
      'media_old_cpy': oldCpy,
      'PayType': payType,
    };
  }
}

class SingerInfo {
  final int id;
  final String name;
  final String? avatar;

  SingerInfo({
    required this.id,
    required this.name,
    this.avatar,
  });

  factory SingerInfo.fromJson(Map<String, dynamic> json) {
    int parseInt(dynamic value) {
      if (value == null) return 0;
      if (value is int) return value;
      if (value is String) return int.tryParse(value) ?? 0;
      return 0;
    }

    return SingerInfo(
      id: parseInt(json['id'] ?? json['AuthorId'] ?? json['author_id'] ?? json['singerid'] ?? json['singer_id']),
      name: (json['name'] ?? json['AuthorName'] ?? json['author_name'] ?? json['singername'] ?? '').toString(),
      avatar: (json['avatar'] ?? json['Avatar'])?.toString(),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'name': name,
      'avatar': avatar,
    };
  }
}
