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
  });

  factory Song.fromJson(Map<String, dynamic> json) {
    var singersList = json['singerinfo'] as List? ?? [];
    List<SingerInfo> singers = singersList.map((i) => SingerInfo.fromJson(i)).toList();
    
    // Sometimes cover is in trans_param
    String cover = json['cover'] ?? json['trans_param']?['union_cover'] ?? '';
    // replace {size} in cover url if needed
    cover = cover.replaceAll('{size}', '400');

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
    );
  }

  String get singerName => singers.map((s) => s.name).join(', ');
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
