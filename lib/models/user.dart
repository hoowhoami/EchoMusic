class User {
  final int userid;
  final String token;
  final String? username;
  final String? nickname;
  final String? mobile;
  final String? pic;
  final int? expires; // timestamp in milliseconds
  final Map<String, dynamic>? extendsInfo;

  User({
    required this.userid,
    required this.token,
    this.username,
    this.nickname,
    this.mobile,
    this.pic,
    this.expires,
    this.extendsInfo,
  });

  factory User.fromJson(Map<String, dynamic> json) {
    return User(
      userid: int.tryParse(json['userid']?.toString() ?? '0') ?? 0,
      token: json['token']?.toString() ?? '',
      username: json['username']?.toString(),
      nickname: json['nickname']?.toString(),
      mobile: json['mobile']?.toString(),
      pic: json['pic']?.toString(),
      expires: int.tryParse(json['expires']?.toString() ?? ''),
      extendsInfo: json['extends'],
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'userid': userid,
      'token': token,
      'username': username,
      'nickname': nickname,
      'mobile': mobile,
      'pic': pic,
      'expires': expires,
      'extends': extendsInfo,
    };
  }

  User copyWith({
    int? userid,
    String? token,
    String? username,
    String? nickname,
    String? mobile,
    String? pic,
    int? expires,
    Map<String, dynamic>? extendsInfo,
  }) {
    return User(
      userid: userid ?? this.userid,
      token: token ?? this.token,
      username: username ?? this.username,
      nickname: nickname ?? this.nickname,
      mobile: mobile ?? this.mobile,
      pic: pic ?? this.pic,
      expires: expires ?? this.expires,
      extendsInfo: extendsInfo ?? this.extendsInfo,
    );
  }
}
