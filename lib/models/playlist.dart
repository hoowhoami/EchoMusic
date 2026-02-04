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
    
    return Playlist(
      id: json['listid'] ?? json['specialid'] ?? json['global_collection_id'] ?? 0,
      name: json['name'] ?? json['specialname'] ?? '',
      pic: pic,
      intro: json['intro'] ?? '',
      playCount: json['play_count'] ?? json['playcount'] ?? 0,
      count: json['song_count'] ?? json['count'] ?? 0,
    );
  }
}
