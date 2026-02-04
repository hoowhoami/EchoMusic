import 'song.dart';

class Playlist {
  final int id;
  final String name;
  final String pic;
  final String intro;
  final int playCount;
  final int count;
  final List<Song>? songs;

  Playlist({
    required this.id,
    required this.name,
    required this.pic,
    required this.intro,
    required this.playCount,
    this.count = 0,
    this.songs,
  });

  factory Playlist.fromJson(Map<String, dynamic> json) {
    String pic = json['pic'] ?? json['imgurl'] ?? json['flexible_cover'] ?? json['img'] ?? '';
    pic = pic.replaceAll('{size}', '400');

    int parseId(dynamic value) {
      if (value == null) return 0;
      if (value is int) return value;
      if (value is String) return int.tryParse(value) ?? 0;
      return 0;
    }

    return Playlist(
      id: parseId(json['listid'] ?? json['specialid'] ?? json['global_collection_id']),
      name: json['name'] ?? json['specialname'] ?? '',
      pic: pic,
      intro: json['intro'] ?? '',
      playCount: parseId(json['play_count'] ?? json['playcount']),
      count: parseId(json['song_count'] ?? json['count']),
    );
  }
}
