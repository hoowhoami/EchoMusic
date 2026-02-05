import 'song.dart';

class Playlist {
  final int id;
  final String name;
  final String pic;
  final String intro;
  final int playCount;
  final int count;
  final List<Song>? songs;
  final bool isPrivate;
  final int? heat;
  final String? publishDate;

  Playlist({
    required this.id,
    required this.name,
    required this.pic,
    required this.intro,
    required this.playCount,
    this.count = 0,
    this.songs,
    this.isPrivate = false,
    this.heat,
    this.publishDate,
  });

  factory Playlist.fromJson(Map<String, dynamic> json) {
    String pic = json['pic'] ?? 
                json['imgurl'] ?? 
                json['flexible_cover'] ?? 
                json['img'] ?? 
                json['cover'] ?? '';
    pic = pic.replaceAll('{size}', '400');

    int parseId(dynamic value) {
      if (value == null) return 0;
      if (value is int) return value;
      if (value is String) return int.tryParse(value) ?? 0;
      return 0;
    }

    final isPri = json['is_pri'] ?? json['is_private'] ?? 0;
    final isPrivate = isPri == 1;

    return Playlist(
      id: parseId(json['listid'] ?? json['specialid'] ?? json['global_collection_id'] ?? json['gid']),
      name: (json['name'] ?? json['specialname'] ?? '').toString(),
      pic: pic.toString(),
      intro: (json['intro'] ?? '').toString(),
      playCount: parseId(json['play_count'] ?? json['playcount'] ?? json['collectcount'] ?? json['count']),
      count: parseId(json['song_count'] ?? json['count']),
      isPrivate: isPrivate,
      heat: json['collectcount'] != null ? parseId(json['collectcount']) : null,
      publishDate: (json['publishtime'] ?? json['publish_time'])?.toString().split(' ')[0],
    );
  }
}
