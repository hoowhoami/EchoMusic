import 'song.dart';

class Playlist {
  final int id;
  final String? globalCollectionId;
  final String? listCreateGid;
  final int? listCreateUserid;
  final int? listCreateListid;
  final int? listid;
  final String name;
  final String pic;
  final String intro;
  final String nickname;
  final String userPic;
  final String tags;
  final int playCount;
  final int count;
  final List<Song>? songs;
  final bool isPrivate;
  final int? heat;
  final String? publishDate;
  final int? createTime;
  final int? updateTime;

  int get originalId => (listCreateListid != null && listCreateListid != 0)
      ? listCreateListid!
      : (id != 0 ? id : (globalCollectionId != null ? (int.tryParse(globalCollectionId!) ?? 0) : 0));

  Playlist({
    required this.id,
    this.globalCollectionId,
    this.listCreateGid,
    this.listCreateUserid,
    this.listCreateListid,
    this.listid,
    required this.name,
    required this.pic,
    required this.intro,
    this.nickname = '',
    this.userPic = '',
    this.tags = '',
    required this.playCount,
    this.count = 0,
    this.songs,
    this.isPrivate = false,
    this.heat,
    this.publishDate,
    this.createTime,
    this.updateTime,
  });

  static int _parseId(dynamic value) {
    if (value == null) return 0;
    if (value is int) return value;
    if (value is String) {
      final numericPart = RegExp(r'^\d+').stringMatch(value);
      if (numericPart != null) {
        return int.tryParse(numericPart) ?? 0;
      }
      return int.tryParse(value) ?? 0;
    }
    return 0;
  }

  static String _formatPic(dynamic value) {
    if (value == null) return '';
    String pic = value.toString().replaceAll('{size}', '400');
    if (pic.startsWith('//')) pic = 'https:$pic';
    return pic;
  }

  factory Playlist.fromJson(Map<String, dynamic> json) {
    if (json.containsKey('specialname') && json.containsKey('img')) {
      return Playlist.fromSearchJson(json);
    }
    if (json.containsKey('list_create_userid') && (json.containsKey('listid') || json.containsKey('specialid'))) {
      return Playlist.fromUserPlaylist(json);
    }
    if (json.containsKey('extra')) {
      return Playlist.fromIP(json);
    }
    return Playlist.fromSpecialPlaylist(json);
  }

  factory Playlist.fromSearchJson(Map<String, dynamic> json) {
    return Playlist(
      id: _parseId(json['specialid']),
      globalCollectionId: json['gid']?.toString(),
      listid: _parseId(json['specialid']),
      listCreateUserid: _parseId(json['suid']),
      name: (json['specialname'] ?? '').toString(),
      pic: _formatPic(json['img']),
      intro: (json['intro'] ?? '').toString(),
      nickname: (json['nickname'] ?? json['username'] ?? json['author'] ?? '').toString(),
      userPic: _formatPic(json['user_pic'] ?? json['avatar'] ?? json['create_user_pic']),
      tags: (json['tags'] ?? '').toString(),
      playCount: _parseId(json['playcount'] ?? json['play_count'] ?? json['count']),
      count: _parseId(json['song_count'] ?? json['songcount'] ?? json['count']),
      publishDate: (json['publish_time'] ?? '').toString().split(' ')[0],
      isPrivate: false,
    );
  }

  factory Playlist.fromUserPlaylist(Map<String, dynamic> json) {
    return Playlist(
      id: _parseId(json['listid'] ?? json['specialid']),
      listid: _parseId(json['listid']),
      globalCollectionId: (json['global_collection_id'] ?? json['gid'] ?? json['specialid'])?.toString(),
      listCreateGid: json['list_create_gid']?.toString(),
      listCreateUserid: _parseId(json['list_create_userid']),
      listCreateListid: _parseId(json['list_create_listid']),
      name: (json['name'] ?? json['specialname'] ?? '').toString(),
      pic: _formatPic(json['pic'] ?? json['imgurl'] ?? json['cover'] ?? json['img']),
      intro: (json['intro'] ?? '').toString(),
      nickname: (json['nickname'] ?? json['username'] ?? json['list_create_username'] ?? '').toString(),
      userPic: _formatPic(json['user_pic'] ?? json['avatar'] ?? json['create_user_pic'] ?? json['pic']),
      tags: (json['tags'] ?? '').toString(),
      playCount: _parseId(json['play_count'] ?? json['playcount'] ?? json['count'] ?? json['play_total']),
      count: _parseId(json['song_count'] ?? json['songcount'] ?? json['count']),
      isPrivate: (json['is_pri'] ?? json['is_private']) == 1,
      heat: _parseId(json['collectcount'] ?? json['collect_count'] ?? json['collect_total']),
      publishDate: (json['publishtime'] ?? json['publish_time'])?.toString().split(' ')[0],
      createTime: json['create_time'] ?? json['addtime'],
      updateTime: json['update_time'],
    );
  }

  factory Playlist.fromSpecialPlaylist(Map<String, dynamic> json) {
    return Playlist(
      id: _parseId(json['specialid'] ?? json['listid'] ?? json['global_collection_id']),
      globalCollectionId: (json['global_collection_id'] ?? json['gid'] ?? json['specialid'])?.toString(),
      listCreateGid: (json['list_create_gid'] ?? json['global_collection_id'] ?? json['gid'] ?? json['specialid'])?.toString(),
      listCreateUserid: _parseId(json['list_create_userid'] ?? json['userid']),
      listCreateListid: _parseId(json['list_create_listid'] ?? json['specialid']),
      name: (json['specialname'] ?? json['name'] ?? '').toString(),
      pic: _formatPic(json['flexible_cover'] ?? json['pic'] ?? json['imgurl'] ?? json['img']),
      intro: (json['intro'] ?? '').toString(),
      nickname: (json['nickname'] ?? json['username'] ?? json['author'] ?? json['list_create_username'] ?? '').toString(),
      userPic: _formatPic(json['user_pic'] ?? json['avatar'] ?? json['create_user_pic'] ?? json['author_pic']),
      tags: (json['tags'] ?? '').toString(),
      playCount: _parseId(json['playcount'] ?? json['play_count'] ?? json['count'] ?? json['play_total']),
      count: _parseId(json['song_count'] ?? json['songcount'] ?? json['count']),
      isPrivate: false,
      heat: _parseId(json['collectcount'] ?? json['collect_count'] ?? json['collect_total']),
      publishDate: (json['publishtime'] ?? json['publish_time'])?.toString().split(' ')[0],
      createTime: json['create_time'] ?? json['addtime'],
      updateTime: json['update_time'],
    );
  }

  factory Playlist.fromIP(Map<String, dynamic> json) {
    final extra = json['extra'] ?? {};
    return Playlist(
      id: _parseId(extra['specialid'] ?? json['id']),
      globalCollectionId: extra['global_collection_id']?.toString(),
      listCreateGid: (extra['global_collection_id'] ?? extra['global_special_id'])?.toString(),
      listCreateUserid: _parseId(extra['list_create_userid']),
      listCreateListid: _parseId(extra['specialid']),
      name: (json['title'] ?? '').toString(),
      pic: _formatPic(json['pic'] ?? json['image_url']),
      intro: (json['sub_title'] ?? '').toString(),
      playCount: _parseId(extra['play_count']),
      count: 0,
      isPrivate: false,
      heat: 0,
    );
  }
}
