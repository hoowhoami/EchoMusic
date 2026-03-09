import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

class MusicApiStoredAuth {
  static const String deviceInfoKey = 'device_info';
  static const String userInfoKey = 'user_info';

  static Future<String?> loadCookieValue() async {
    final prefs = await SharedPreferences.getInstance();
    return buildCookieValue(prefs);
  }

  static String? buildCookieValue(SharedPreferences prefs) {
    final device = _decodeJsonMap(prefs.getString(deviceInfoKey));
    final userInfo = _decodeJsonMap(prefs.getString(userInfoKey));

    final token = userInfo?['token'];
    final userid = userInfo?['userid'];
    final t1 = userInfo?['t1'];
    final dfid = device?['dfid'];
    final mid = device?['mid'];
    final guid = device?['guid'];
    final serverDev = device?['serverDev'];
    final mac = device?['mac'];

    final authParts = <String>[];
    if (token != null) authParts.add('token=$token');
    if (userid != null) authParts.add('userid=$userid');
    if (dfid != null) authParts.add('dfid=$dfid');
    if (t1 != null) authParts.add('t1=$t1');
    if (mid != null) authParts.add('KUGOU_API_MID=$mid');
    if (guid != null) authParts.add('KUGOU_API_GUID=$guid');
    if (serverDev != null) authParts.add('KUGOU_API_DEV=$serverDev');
    if (mac != null) authParts.add('KUGOU_API_MAC=$mac');

    if (authParts.isEmpty) {
      return null;
    }

    return authParts.join(';');
  }

  static Map<String, dynamic>? _decodeJsonMap(String? value) {
    if (value == null || value.isEmpty) {
      return null;
    }

    final decoded = jsonDecode(value);
    if (decoded is Map<String, dynamic>) {
      return decoded;
    }
    if (decoded is Map) {
      return decoded.map((key, value) => MapEntry(key.toString(), value));
    }
    return null;
  }
}
