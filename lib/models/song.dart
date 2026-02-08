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
  });

  // For /top/song and /everyday/recommend
  factory Song.fromTopSongJson(Map<String, dynamic> json) {
    int parseInt(dynamic value) {
      if (value == null) return 0;
      if (value is int) return value;
      return int.tryParse(value.toString()) ?? 0;
    }

    var singersList = json['authors'] as List? ?? [];
    List<SingerInfo> singers = singersList.map((i) => SingerInfo.fromJson(i)).toList();
    if (singers.isEmpty && json['author_name'] != null) {
      singers = [SingerInfo(id: 0, name: json['author_name'].toString())];
    }

    String cover = json['album_sizable_cover'] ?? 
                   json['trans_param']?['union_cover'] ?? '';
    cover = cover.replaceAll('{size}', '400');

    return Song(
      hash: (json['hash'] ?? json['hash_128'] ?? '').toString(),
      name: _processName((json['songname'] ?? json['filename'] ?? '').toString()),
      albumName: (json['album_name'] ?? '').toString(),
      albumId: json['album_id']?.toString(),
      singers: singers,
      duration: parseInt(json['timelength'] ?? 0) ~/ 1000,
      cover: cover,
      mvHash: json['video_hash']?.toString(),
      mixSongId: parseInt(json['audio_id'] ?? json['album_audio_id'] ?? 0),
      privilege: parseInt(json['privilege'] ?? 0),
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

    var singersList = json['singerinfo'] as List? ?? json['authors'] as List? ?? [];
    List<SingerInfo> singers = singersList.map((i) => SingerInfo.fromJson(i)).toList();
    if (singers.isEmpty && json['author_name'] != null) {
      singers = [SingerInfo(id: 0, name: json['author_name'].toString())];
    }
    
    final albumInfo = json['albuminfo'] ?? json['album_info'] ?? {};
    String cover = json['cover'] ?? albumInfo['cover'] ?? albumInfo['sizable_cover'] ?? '';
    cover = cover.replaceAll('{size}', '400');

    int duration = parseInt(json['timelen'] ?? audioInfo['duration_128'] ?? audioInfo['duration'] ?? 0);

    return Song(
      hash: hash,
      name: _processName((json['name'] ?? json['songname'] ?? '').toString()),
      albumName: (albumInfo['name'] ?? albumInfo['album_name'] ?? '').toString(),
      albumId: (albumInfo['id'] ?? json['album_id'])?.toString(),
      singers: singers,
      duration: duration ~/ 1000,
      cover: cover,
      mvHash: (json['mvhash'] ?? json['video_hash'])?.toString(),
      mixSongId: parseInt(json['mixsongid'] ?? json['audio_id'] ?? 0),
      fileId: json['fileid'] != null ? parseInt(json['fileid']) : null,
      privilege: parseInt(json['privilege'] ?? 0),
      relateGoods: (json['relate_goods'] as List?)?.cast<Map<String, dynamic>>(),
    );
  }

  // For /user/cloud
  factory Song.fromCloudJson(Map<String, dynamic> json) {
    int parseInt(dynamic value) {
      if (value == null) return 0;
      if (value is int) return value;
      return int.tryParse(value.toString()) ?? 0;
    }

    return Song(
      hash: (json['hash'] ?? '').toString(),
      name: (json['songname'] ?? json['filename'] ?? '').toString(),
      albumName: (json['albumname'] ?? '').toString(),
      albumId: json['albumid']?.toString(),
      singers: [SingerInfo(id: 0, name: (json['singername'] ?? '未知歌手').toString())],
      duration: parseInt(json['duration'] ?? 0),
      cover: '', // Cloud songs often don't have covers in the list
      mixSongId: parseInt(json['mixsongid'] ?? 0),
      source: 'cloud',
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

    String cover = albumInfo['sizable_cover'] ?? transParam['union_cover'] ?? '';
    cover = cover.replaceAll('{size}', '400');

    int duration = parseInt(audioInfo['duration_128'] ?? audioInfo['duration'] ?? 0) ~/ 1000;

    var singersList = json['authors'] as List? ?? [];
    List<SingerInfo> singers = singersList.map((i) => SingerInfo.fromJson(i)).toList();
    if (singers.isEmpty && json['author_name'] != null) {
      singers = [SingerInfo(id: 0, name: json['author_name'].toString())];
    }

    return Song(
      hash: (audioInfo['hash_128'] ?? audioInfo['hash'] ?? '').toString(),
      name: _processName((json['songname'] ?? '').toString()),
      albumName: (albumInfo['album_name'] ?? '').toString(),
      albumId: json['album_id']?.toString(),
      singers: singers,
      duration: duration,
      cover: cover,
      mixSongId: parseInt(json['audio_id'] ?? 0),
      privilege: parseInt(json['privilege'] ?? 0),
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

    String cover = albumInfo['cover'] ?? transParam['union_cover'] ?? '';
    cover = cover.replaceAll('{size}', '400');

    int duration = parseInt(audioInfo['duration'] ?? 0) ~/ 1000;

    var singersList = json['authors'] as List? ?? [];
    List<SingerInfo> singers = singersList.map((i) => SingerInfo.fromJson(i)).toList();
    if (singers.isEmpty && base['author_name'] != null) {
      singers = [SingerInfo(id: 0, name: base['author_name'].toString())];
    }

    return Song(
      hash: (audioInfo['hash'] ?? '').toString(),
      name: _processName((base['audio_name'] ?? '').toString()),
      albumName: (albumInfo['album_name'] ?? '').toString(),
      albumId: base['album_id']?.toString(),
      singers: singers,
      duration: duration,
      cover: cover,
      mixSongId: parseInt(base['audio_id'] ?? 0),
    );
  }

  // Specifically for Search API results
  factory Song.fromSearchJson(Map<String, dynamic> json) {
    final relateGoods = <Map<String, dynamic>>[];
    if (json['HQ'] != null) relateGoods.add({'hash': json['HQ']['hash'], 'quality': '320'});
    if (json['SQ'] != null) relateGoods.add({'hash': json['SQ']['hash'], 'quality': 'flac'});

    final singers = (json['Singers'] as List?)?.map((s) => SingerInfo.fromJson({
      'id': s['id'],
      'name': s['name'],
    })).toList() ?? [];

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
      privilege: int.tryParse((json['AlbumPrivilege'] ?? 0).toString()),
      relateGoods: relateGoods,
    );
  }

  // Specifically for Artist Audios API results
  factory Song.fromArtistSongJson(Map<String, dynamic> json) {
    final relateGoods = <Map<String, dynamic>>[];
    if (json['hash_320'] != null) relateGoods.add({'hash': json['hash_320'], 'quality': '320'});
    if (json['hash_flac'] != null) relateGoods.add({'hash': json['hash_flac'], 'quality': 'flac'});

    return Song(
      hash: (json['hash'] ?? '').toString(),
      name: (json['audio_name'] ?? '').toString(),
      albumName: (json['album_name'] ?? '').toString(),
      albumId: json['album_id']?.toString(),
      singers: [SingerInfo(id: 0, name: (json['author_name'] ?? '未知歌手').toString())],
      duration: (int.tryParse((json['timelength'] ?? 0).toString()) ?? 0) ~/ 1000,
      cover: (json['trans_param']?['union_cover'] ?? '').toString().replaceAll('{size}', '400'),
      mixSongId: int.tryParse((json['mixsongid'] ?? 0).toString()) ?? 0,
      relateGoods: relateGoods,
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

  String get singerName => singers.isEmpty ? '未知歌手' : singers.map((s) => s.name).join(', ');

  String get title => name; // name is already processed title

  bool get isVip => privilege == 10;

  bool get isPaid => privilege == 30;

  bool get isUnavailable => privilege == 0 || privilege == 40;

  bool get canPlay => !isUnavailable;

  String get privilegeLabel {
    if (isUnavailable) return '不可用';
    if (isVip) return 'VIP';
    if (isPaid) return '付费';
    return '';
  }

  String get qualityTag {
    if (relateGoods == null) return '';
    if (relateGoods!.length > 2) return 'SQ';
    if (relateGoods!.length > 1) return 'HQ';
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
      id: parseInt(json['id']),
      name: (json['name'] ?? json['author_name'] ?? json['singername'] ?? '').toString(),
      avatar: json['avatar']?.toString(),
    );
  }
}
