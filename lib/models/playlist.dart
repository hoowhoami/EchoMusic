import 'song.dart';

class Playlist {
  final int id;
  final String? globalCollectionId;
  final String? listCreateGid; // 新增：原始歌单 ID
  final int? listCreateUserid; // 新增：歌单创建者 ID
  final int? listid;
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
    this.globalCollectionId,
    this.listCreateGid,
    this.listCreateUserid,
    this.listid,
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
    if (pic.startsWith('//')) pic = 'https:$pic';

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
      globalCollectionId: (json['global_collection_id'] ?? json['gid'] ?? json['specialid'])?.toString(),
      listCreateGid: (json['list_create_gid'] ?? json['gid'] ?? json['specialid'])?.toString(),
      listCreateUserid: json['list_create_userid'] != null ? parseId(json['list_create_userid']) : null,
      listid: json['listid'] != null ? parseId(json['listid']) : null,
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
