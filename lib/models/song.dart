class Song {
  final String hash;
  final String name;
  final String albumName;
  final String? albumId;
  final List<SingerInfo> singers;
  final int duration; // in seconds
  final String cover;
  final String? mvHash;
  final int mixSongId;
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
    this.privilege,
    this.relateGoods,
    this.source,
  });

  factory Song.fromJson(Map<String, dynamic> json) {
    var singersList = json['singerinfo'] as List? ?? json['authors'] as List? ?? [];
    List<SingerInfo> singers = singersList.map((i) => SingerInfo.fromJson(i)).toList();
    
    // Support multiple cover field names and nested album info
    String cover = json['cover'] ?? 
                   json['sizable_cover'] ?? 
                   json['album_cover'] ??
                   json['album_info']?['cover'] ??
                   json['trans_param']?['union_cover'] ?? '';
    // replace {size} in cover url if needed
    cover = cover.replaceAll('{size}', '400');

    var relateGoodsRaw = json['relate_goods'];
    List<Map<String, dynamic>>? relateGoods;
    if (relateGoodsRaw is List) {
      relateGoods = relateGoodsRaw.cast<Map<String, dynamic>>();
    }

    int parseInt(dynamic value) {
      if (value == null) return 0;
      if (value is int) return value;
      if (value is String) return int.tryParse(value) ?? 0;
      return 0;
    }

    // Support multiple duration field names (some in ms, some in s) and nested audio info
    int duration = 0;
    dynamic timelen = json['timelen'] ?? json['timelength'] ?? json['audio_info']?['duration'] ?? json['audio_info']?['timelen'];
    if (timelen != null) {
      duration = (parseInt(timelen) / 1000).floor();
    } else if (json['time_length'] != null) {
      duration = parseInt(json['time_length']);
    }

    return Song(
      hash: (json['hash'] ?? json['audio_info']?['hash'] ?? '').toString(),
      name: (json['name'] ?? json['songname'] ?? json['audio_name'] ?? json['base']?['audio_name'] ?? json['filename'] ?? '').toString(),
      albumName: (json['albuminfo']?['name'] ?? json['album_name'] ?? json['album_info']?['album_name'] ?? '').toString(),
      albumId: (json['album_id'] ?? json['base']?['album_id'] ?? json['album_audio_id'])?.toString(),
      singers: singers,
      duration: duration,
      cover: cover.toString(),
      mvHash: (json['mvhash'] ?? json['mv_hash'] ?? json['video_hash'])?.toString(),
      mixSongId: parseInt(json['mixsongid'] ?? json['base']?['mixsongid'] ?? json['base']?['audio_id']),
      privilege: json['privilege'] is int ? json['privilege'] : (json['privilege'] != null ? int.tryParse(json['privilege'].toString()) : null),
      relateGoods: relateGoods,
      source: json['source']?.toString(),
    );
  }

  String get singerName => singers.map((s) => s.name).join(', ');

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
