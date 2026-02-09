import 'package:dio/dio.dart';
import 'package:package_info_plus/package_info_plus.dart';

class UpdateInfo {
  final String version;
  final String releaseNotes;
  final String url;
  final bool hasUpdate;

  UpdateInfo({
    required this.version,
    required this.releaseNotes,
    required this.url,
    this.hasUpdate = false,
  });
}

class VersionService {
  static const String _repoUrl = 'https://api.github.com/repos/hoowhoami/EchoMusic/releases/latest';

  static Future<UpdateInfo?> checkForUpdates() async {
    try {
      final dio = Dio();
      final response = await dio.get(_repoUrl);
      
      if (response.statusCode == 200) {
        final data = response.data;
        final latestVersion = data['tag_name'].toString().replaceAll('v', '');
        final releaseNotes = data['body'] ?? '暂无更新说明';
        final htmlUrl = data['html_url'] ?? 'https://github.com/hoowhoami/EchoMusic/releases';
        
        final packageInfo = await PackageInfo.fromPlatform();
        final currentVersion = packageInfo.version;

        return UpdateInfo(
          version: latestVersion,
          releaseNotes: releaseNotes,
          url: htmlUrl,
          hasUpdate: _isVersionNewer(currentVersion, latestVersion),
        );
      }
    } catch (e) {
      print('检查更新失败: $e');
    }
    return null;
  }

  static bool _isVersionNewer(String current, String latest) {
    List<int> currentParts = current.split('.').map(int.parse).toList();
    List<int> latestParts = latest.split('.').map(int.parse).toList();

    for (int i = 0; i < latestParts.length; i++) {
      int currentPart = i < currentParts.length ? currentParts[i] : 0;
      if (latestParts[i] > currentPart) return true;
      if (latestParts[i] < currentPart) return false;
    }
    return false;
  }
}
