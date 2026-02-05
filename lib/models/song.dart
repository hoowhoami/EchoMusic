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
    var singersList = json['singerinfo'] as List? ?? [];
    List<SingerInfo> singers = singersList.map((i) => SingerInfo.fromJson(i)).toList();
    
    // Sometimes cover is in trans_param
    String cover = json['cover'] ?? json['trans_param']?['union_cover'] ?? '';
    // replace {size} in cover url if needed
    cover = cover.replaceAll('{size}', '400');

    var relateGoodsList = json['relate_goods'] as List?;
    List<Map<String, dynamic>>? relateGoods = relateGoodsList?.cast<Map<String, dynamic>>();

    int parseInt(dynamic value) {
      if (value == null) return 0;
      if (value is int) return value;
      if (value is String) return int.tryParse(value) ?? 0;
      return 0;
    }

    return Song(
      hash: (json['hash'] ?? '').toString(),
      name: (json['name'] ?? json['songname'] ?? '').toString(),
      albumName: (json['albuminfo']?['name'] ?? json['album_name'] ?? '').toString(),
      albumId: json['album_id']?.toString(),
      singers: singers,
      duration: json['timelen'] != null ? (parseInt(json['timelen']) / 1000).floor() : 0,
      cover: cover.toString(),
      mvHash: json['mvhash']?.toString(),
      mixSongId: parseInt(json['mixsongid']),
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
      name: (json['name'] ?? json['author_name'] ?? '').toString(),
      avatar: json['avatar']?.toString(),
    );
  }
}
