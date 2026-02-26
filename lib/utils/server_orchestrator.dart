import 'dart:io';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:path/path.dart' as p;
import 'package:dio/dio.dart';
import 'logger.dart';

class ServerOrchestrator {
  static Process? _serverProcess;
  static final Dio _pingDio = Dio(BaseOptions(
    connectTimeout: const Duration(milliseconds: 500),
    receiveTimeout: const Duration(milliseconds: 500),
  ));

  static Future<bool> isServerRunning() async {
    try {
      final response = await _pingDio.get('http://127.0.0.1:10086/server/now');
      return response.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  /// 异步清理端口，不阻塞主流程
  static void fireAndForgetKillPort() {
    killPort().timeout(const Duration(seconds: 2), onTimeout: () {
      LoggerService.w('[Server] Port cleanup task reached timeout, moving on.');
    });
  }

  static Future<void> killPort() async {
    try {
      if (Platform.isWindows) {
        // 直接执行 taskkill 尝试杀死可能残留的服务器进程名，比查端口更高效稳定
        await Process.run('taskkill', ['/F', '/IM', 'app_win.exe', '/T']);
      } else {
        final result = await Process.run('lsof', ['-ti', ':10086']).timeout(const Duration(seconds: 1));
        final pid = result.stdout.toString().trim();
        if (pid.isNotEmpty) {
          await Process.run('kill', ['-9', pid]);
        }
      }
    } catch (e) {
      // 忽略清理阶段的所有错误
    }
  }

  static Future<bool> start() async {
    if (_serverProcess != null) return true;

    // 如果服务已经在运行（可能是之前没退干净），直接复用，不重启
    if (await isServerRunning()) {
      LoggerService.i('[Server] Existing server detected, reusing.');
      return true;
    }

    LoggerService.i('[Server] Starting pre-start cleanup (non-blocking)...');
    // 使用非阻塞方式清理
    fireAndForgetKillPort();

    try {
      final args = ['--port=10086', '--platform=lite', '--host=0.0.0.0'];
      
      if (kDebugMode) {
        // Debug 模式保持原样
        String? serverDir;
        Directory anchorDir = Directory(p.dirname(Platform.resolvedExecutable));
        for (int i = 0; i < 10; i++) {
          final potential = p.join(anchorDir.path, 'server');
          if (Directory(potential).existsSync() && File(p.join(potential, 'package.json')).existsSync()) {
            serverDir = potential;
            break;
          }
          anchorDir = anchorDir.parent;
        }
        
        if (serverDir != null) {
          final npmCmd = Platform.isWindows ? 'npm.cmd' : 'npm';
          _serverProcess = await Process.start(npmCmd, ['start', '--', ...args], workingDirectory: serverDir);
        }
      } else {
        // 生产模式
        final executableName = Platform.isWindows ? 'app_win.exe' : (Platform.isMacOS ? 'app_macos' : 'app_linux');
        final appDir = p.dirname(Platform.resolvedExecutable);
        String serverPath = Platform.isMacOS 
            ? p.join(appDir, '..', 'Resources', 'server', executableName)
            : p.join(appDir, 'server', executableName);

        if (File(serverPath).existsSync()) {
          LoggerService.i('[Server] Launching binary: $serverPath');
          _serverProcess = await Process.start(serverPath, args);
        }
      }

      if (_serverProcess == null) return false;

      // 监听日志输出（使用 malformed 容错）
      _serverProcess?.stdout.listen((data) => LoggerService.d('[Server] ${utf8.decode(data, allowMalformed: true).trim()}'));
      _serverProcess?.stderr.listen((data) => LoggerService.e('[Server] ${utf8.decode(data, allowMalformed: true).trim()}'));

      // 健康检查
      for (int i = 0; i < 20; i++) {
        await Future.delayed(const Duration(milliseconds: 500));
        if (await isServerRunning()) return true;
      }
    } catch (e) {
      LoggerService.e('[Server] Startup critical error', e);
    }

    return false;
  }

  static void stop() {
    _serverProcess?.kill();
    _serverProcess = null;
    killPort();
  }
}
