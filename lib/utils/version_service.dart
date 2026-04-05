import 'package:dio/dio.dart';
import 'package:package_info_plus/package_info_plus.dart';

class UpdateInfo {
  final String version;
  final String releaseNotes;
  final String url;
  final bool hasUpdate;
  final bool isPrerelease;

  UpdateInfo({
    required this.version,
    required this.releaseNotes,
    required this.url,
    this.hasUpdate = false,
    this.isPrerelease = false,
  });
}

class VersionService {
  static const String _repoUrl = 'https://api.github.com/repos/hoowhoami/EchoMusic/releases';
  
  /// 推荐在构建时注入原始版本号：--dart-define=APP_RAW_VERSION=1.1.5-beta.5+18
  static const String _rawVersionFromEnv = String.fromEnvironment('APP_RAW_VERSION');

  /// 获取当前应用最真实的完整版本号
  static Future<String> getFullVersion() async {
    if (_rawVersionFromEnv.isNotEmpty) return _rawVersionFromEnv;
    final packageInfo = await PackageInfo.fromPlatform();
    // 兼容 OS 转换后的版本号 (1.1.5+18 或 1.1.5.18)
    return '${packageInfo.version}+${packageInfo.buildNumber}';
  }

  /// 检查给定版本字符串是否为预发布版本
  static bool isPrereleaseVersion(String version) {
    try {
      return AppVersion.parse(version).isPrerelease;
    } catch (_) {
      return false;
    }
  }

  /// 检查更新
  static Future<UpdateInfo?> checkForUpdates({bool checkPrerelease = false}) async {
    try {
      final response = await Dio().get(_repoUrl);
      if (response.statusCode != 200 || (response.data as List).isEmpty) return null;

      final currentStr = await getFullVersion();
      final current = AppVersion.parse(currentStr);
      final List<dynamic> releases = response.data;

      dynamic bestRelease;
      for (final rel in releases) {
        final bool isPre = rel['prerelease'] ?? false;
        // 如果用户没开启预发布检查且当前不是预发布版，则跳过预发布更新
        if (isPre && !checkPrerelease && !current.isPrerelease) continue;

        final tagVersion = AppVersion.parse(rel['tag_name']);
        if (bestRelease == null || tagVersion.isNewerThan(AppVersion.parse(bestRelease['tag_name']))) {
          bestRelease = rel;
        }
      }

      if (bestRelease != null) {
        final latestVersion = AppVersion.parse(bestRelease['tag_name']);
        return UpdateInfo(
          version: bestRelease['tag_name'].toString().replaceAll('v', ''),
          releaseNotes: bestRelease['body'] ?? '暂无更新说明',
          url: bestRelease['html_url'] ?? '',
          hasUpdate: latestVersion.isNewerThan(current),
          isPrerelease: bestRelease['prerelease'] ?? false,
        );
      }
    } catch (_) {}
    return null;
  }
}

/// 严格遵循规则的轻量级版本解析器
/// 格式：x.y.z[-stage.number][+build]
class AppVersion {
  final List<int> numbers; // [Major, Minor, Patch, StageWeight, StageNum, Build]

  AppVersion(this.numbers);

  bool get isPrerelease => numbers[3] < 4;

  static AppVersion parse(String v) {
    // 1. 处理构建号 (+)
    final buildSplit = v.split('+');
    int build = int.tryParse(buildSplit.length > 1 ? buildSplit[1] : '0') ?? 0;
    
    // 2. 处理预发布标识 (-)
    final preSplit = buildSplit[0].split('-');
    final mainString = preSplit[0].replaceAll('v', '');
    final mainParts = mainString.split('.');
    
    // 兼容：如果是 Windows 自动转换的四段式 (1.1.5.18) 且无显式 +build
    if (mainParts.length > 3 && build == 0) {
      build = int.tryParse(mainParts[3]) ?? 0;
    }

    int stageWeight = 4; // 1:alpha, 2:beta, 3:rc, 4:stable
    int stageNum = 0;

    if (preSplit.length > 1) {
      final stageParts = preSplit[1].toLowerCase().split('.');
      stageWeight = {'alpha': 1, 'beta': 2, 'rc': 3}[stageParts[0]] ?? 0;
      stageNum = int.tryParse(stageParts.length > 1 ? stageParts[1] : '0') ?? 0;
    }

    return AppVersion([
      int.tryParse(mainParts[0]) ?? 0,
      mainParts.length > 1 ? int.tryParse(mainParts[1]) ?? 0 : 0,
      mainParts.length > 2 ? int.tryParse(mainParts[2]) ?? 0 : 0,
      stageWeight,
      stageNum,
      build,
    ]);
  }

  /// 线性比较 numbers 列表
  bool isNewerThan(AppVersion other) {
    for (int i = 0; i < numbers.length; i++) {
      if (numbers[i] > other.numbers[i]) return true;
      if (numbers[i] < other.numbers[i]) return false;
    }
    return false;
  }
}
