class Artist {
  final int id;
  final String name;
  final String pic;
  final String intro;
  final int songCount;
  final int albumCount;
  final int mvCount;
  final int fansCount;

  Artist({
    required this.id,
    required this.name,
    required this.pic,
    required this.intro,
    this.songCount = 0,
    this.albumCount = 0,
    this.mvCount = 0,
    this.fansCount = 0,
  });

  static String _formatPic(dynamic value) {
    if (value == null) return '';
    String pic = value.toString().replaceAll('{size}', '400');
    if (pic.startsWith('//')) pic = 'https:$pic';
    return pic;
  }

  static int _parseInt(dynamic value) {
    if (value == null) return 0;
    if (value is int) return value;
    return int.tryParse(value.toString()) ?? 0;
  }

  factory Artist.fromJson(Map<String, dynamic> json) {
    // 自动识别搜索结果
    if (json.containsKey('AuthorId')) {
      return Artist.fromSearchJson(json);
    }
    return Artist(
      id: _parseInt(json['AuthorId'] ?? json['singerid'] ?? json['id'] ?? json['author_id'] ?? json['singer_id']),
      name: (json['AuthorName'] ?? json['singername'] ?? json['author_name'] ?? json['name'] ?? json['singer_name'] ?? '').toString(),
      pic: _formatPic(json['Avatar'] ?? json['imgurl'] ?? json['avatar'] ?? json['pic'] ?? json['image'] ?? json['singer_img'] ?? json['sizable_avatar']),
      intro: (json['intro'] ?? json['long_intro'] ?? json['profile'] ?? json['singer_intro'] ?? '').toString(),
      songCount: _parseInt(json['AudioCount'] ?? json['song_count'] ?? json['songcount'] ?? json['audio_count'] ?? json['song_num']),
      albumCount: _parseInt(json['AlbumCount'] ?? json['album_count'] ?? json['albumcount'] ?? json['album_num']),
      mvCount: _parseInt(json['VideoCount'] ?? json['mv_count'] ?? json['mvcount'] ?? json['mv_num']),
      fansCount: _parseInt(json['FansNum'] ?? json['fansnums'] ?? json['fans_count'] ?? json['fans'] ?? json['fans_num'] ?? json['fanscount']),
    );
  }

  factory Artist.fromSearchJson(Map<String, dynamic> json) {
    return Artist(
      id: _parseInt(json['AuthorId'] ?? json['singerid']),
      name: (json['AuthorName'] ?? json['singername'] ?? json['name'] ?? '').toString(),
      pic: _formatPic(json['Avatar'] ?? json['imgurl'] ?? json['pic'] ?? json['image']),
      intro: (json['intro'] ?? '').toString(),
      songCount: _parseInt(json['AudioCount'] ?? json['songcount'] ?? json['song_count']),
      albumCount: _parseInt(json['AlbumCount'] ?? json['albumcount'] ?? json['album_count']),
      mvCount: _parseInt(json['VideoCount'] ?? json['mvcount'] ?? json['mv_num']),
      fansCount: _parseInt(json['FansNum'] ?? json['fanscount'] ?? json['fans_count']),
    );
  }

  factory Artist.fromDetailJson(Map<String, dynamic> json) {
    String introStr = '';
    if (json['long_intro'] is List) {
      introStr = (json['long_intro'] as List).map((e) => e['content']).join('\n\n');
    } else {
      introStr = (json['long_intro'] ?? json['intro'] ?? json['profile'] ?? '').toString();
    }

    return Artist(
      id: _parseInt(json['AuthorId'] ?? json['author_id'] ?? json['singerid'] ?? json['id']),
      name: (json['AuthorName'] ?? json['author_name'] ?? json['singername'] ?? json['name'] ?? '').toString(),
      pic: _formatPic(json['sizable_avatar'] ?? json['Avatar'] ?? json['imgurl'] ?? json['pic']),
      intro: introStr,
      songCount: _parseInt(json['AudioCount'] ?? json['song_count'] ?? json['songcount'] ?? json['audio_count'] ?? json['song_num']),
      albumCount: _parseInt(json['AlbumCount'] ?? json['album_count'] ?? json['albumcount'] ?? json['album_num']),
      mvCount: _parseInt(json['VideoCount'] ?? json['mv_count'] ?? json['mvcount'] ?? json['mv_num']),
      fansCount: _parseInt(json['FansNum'] ?? json['fansnums'] ?? json['fanscount'] ?? json['fans_count'] ?? json['fans_num']),
    );
  }
}
