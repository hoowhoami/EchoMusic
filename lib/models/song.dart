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

    return Song(
      hash: json['hash'] ?? '',
      name: json['name'] ?? json['songname'] ?? '',
      albumName: json['albuminfo']?['name'] ?? json['album_name'] ?? '',
      albumId: json['album_id']?.toString(),
      singers: singers,
      duration: json['timelen'] != null ? (json['timelen'] / 1000).floor() : 0,
      cover: cover,
      mvHash: json['mvhash'],
      mixSongId: json['mixsongid'] ?? 0,
      privilege: json['privilege'],
      relateGoods: relateGoods,
      source: json['source'],
    );
  }

  String get singerName => singers.map((s) => s.name).join(', ');
  
  bool get isVip => privilege == 10;
  
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
    return SingerInfo(
      id: json['id'] ?? 0,
      name: json['name'] ?? json['author_name'] ?? '',
      avatar: json['avatar'],
    );
  }
}
