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
        final latestVersion = data['tag_name'].toString().replaceAll('v', '').trim();
        final releaseNotes = data['body'] ?? '暂无更新说明';
        final htmlUrl = data['html_url'] ?? 'https://github.com/hoowhoami/EchoMusic/releases';
        
        final packageInfo = await PackageInfo.fromPlatform();
        final currentVersion = packageInfo.version.trim();

        return UpdateInfo(
          version: latestVersion,
          releaseNotes: releaseNotes,
          url: htmlUrl,
          hasUpdate: _isVersionNewer(currentVersion, latestVersion),
        );
      }
    } catch (e) {
      // 检查更新失败时不应干扰主流程
    }
    return null;
  }

  static bool _isVersionNewer(String current, String latest) {
    if (current.trim() == latest.trim()) return false;
    
    try {
      // Helper to convert version string like "1.0.3+4" to list of ints [1, 0, 3]
      List<int> toParts(String v) {
        final clean = v.split('+')[0].split('-')[0].trim();
        return clean.split('.').map((e) => int.tryParse(e) ?? 0).toList();
      }

      final cParts = toParts(current);
      final lParts = toParts(latest);

      // Compare major.minor.patch
      for (int i = 0; i < 3; i++) {
        final c = i < cParts.length ? cParts[i] : 0;
        final l = i < lParts.length ? lParts[i] : 0;
        if (l > c) return true;
        if (l < c) return false;
      }
      
      // If we are here, major.minor.patch are equal.
      // Now check if build number (after +) exists and is newer
      if (current.contains('+') && latest.contains('+')) {
        final cBuild = int.tryParse(current.split('+').last) ?? 0;
        final lBuild = int.tryParse(latest.split('+').last) ?? 0;
        return lBuild > cBuild;
      }
    } catch (_) {}
    return false;
  }
}
