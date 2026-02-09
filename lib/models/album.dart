class Album {
  final int id;
  final String name;
  final String pic;
  final String intro;
  final String singerName;
  final int singerId;
  final String publishTime;
  final int songCount;
  final int playCount;
  final int heat;
  final String language;
  final String type;
  final String company;

  Album({
    required this.id,
    required this.name,
    required this.pic,
    required this.intro,
    required this.singerName,
    this.singerId = 0,
    required this.publishTime,
    this.songCount = 0,
    this.playCount = 0,
    this.heat = 0,
    this.language = '',
    this.type = '',
    this.company = '',
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

  factory Album.fromJson(Map<String, dynamic> json) {
    // 自动识别搜索结果格式
    if (json.containsKey('AlbumID') || json.containsKey('albumname')) {
      return Album.fromSearchJson(json);
    }
    return Album(
      id: _parseInt(json['AlbumId'] ?? json['albumid'] ?? json['album_id'] ?? json['id']),
      name: (json['AlbumName'] ?? json['albumname'] ?? json['album_name'] ?? json['name'] ?? '').toString(),
      pic: _formatPic(json['img'] ?? json['Image'] ?? json['imgurl'] ?? json['sizable_cover'] ?? json['pic'] ?? json['cover']),
      intro: (json['intro'] ?? json['album_intro'] ?? '').toString(),
      singerName: (json['SingerName'] ?? json['singername'] ?? json['singer_name'] ?? json['author_name'] ?? json['singer'] ?? '').toString(),
      singerId: _parseInt(json['SingerId'] ?? json['singerid'] ?? json['author_id'] ?? json['singer_id']),
      publishTime: (json['PublishTime'] ?? json['publishtime'] ?? json['publish_time'] ?? json['publish_date'] ?? '').toString().split(' ')[0],
      songCount: _parseInt(json['SongCount'] ?? json['song_count'] ?? json['count'] ?? json['songcount'] ?? json['total_count']),
      playCount: _parseInt(json['play_count'] ?? json['play_times'] ?? json['play_count'] ?? json['playcount']),
      heat: _parseInt(json['heat'] ?? json['collect_count'] ?? json['collectcount']),
      language: (json['language'] ?? '').toString(),
      type: (json['type'] ?? '').toString(),
      company: (json['company'] ?? '').toString(),
    );
  }

  factory Album.fromSearchJson(Map<String, dynamic> json) {
    return Album(
      id: _parseInt(json['albumid'] ?? json['AlbumId'] ?? json['id']),
      name: (json['albumname'] ?? json['AlbumName'] ?? json['name'] ?? '').toString(),
      pic: _formatPic(json['img'] ?? json['Image'] ?? json['imgurl'] ?? json['ImgURL'] ?? json['pic']),
      intro: (json['intro'] ?? '').toString(),
      singerName: (json['singername'] ?? json['SingerName'] ?? json['singer'] ?? '').toString(),
      singerId: _parseInt(json['singerid'] ?? json['SingerId'] ?? json['singer_id']),
      publishTime: (json['publishtime'] ?? json['PublishTime'] ?? json['publish_time'] ?? '').toString().split(' ')[0],
      songCount: _parseInt(json['songcount'] ?? json['SongCount'] ?? json['song_count']),
      playCount: _parseInt(json['play_count'] ?? json['play_times'] ?? json['play_count'] ?? json['playcount']),
      heat: _parseInt(json['heat'] ?? json['collect_count'] ?? json['collectcount']),
      language: (json['language'] ?? '').toString(),
      type: (json['type'] ?? '').toString(),
      company: (json['company'] ?? '').toString(),
    );
  }

  factory Album.fromDetailJson(Map<String, dynamic> json) {
    return Album(
      id: _parseInt(json['album_id'] ?? json['albumid'] ?? json['id']),
      name: (json['album_name'] ?? json['albumname'] ?? json['name'] ?? '').toString(),
      pic: _formatPic(json['sizable_cover'] ?? json['imgurl'] ?? json['img'] ?? json['pic'] ?? json['cover']),
      intro: (json['intro'] ?? '').toString(),
      singerName: (json['author_name'] ?? json['singername'] ?? json['singer'] ?? json['author_name'] ?? '').toString(),
      singerId: _parseInt(json['author_id'] ?? json['singerid'] ?? json['author_id']),
      publishTime: (json['publish_date'] ?? json['publishtime'] ?? json['publish_time'] ?? '').toString().split(' ')[0],
      songCount: _parseInt(json['song_count'] ?? json['songcount']),
      playCount: _parseInt(json['play_count'] ?? json['play_times'] ?? json['play_count'] ?? json['playcount']),
      heat: _parseInt(json['heat'] ?? json['collect_count'] ?? json['collectcount']),
      language: (json['language'] ?? '').toString(),
      type: (json['type'] ?? '').toString(),
      company: (json['company'] ?? '').toString(),
    );
  }
}
