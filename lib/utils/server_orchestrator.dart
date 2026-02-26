import 'dart:io';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:path/path.dart' as p;
import 'package:dio/dio.dart';
import 'logger.dart';

class ServerOrchestrator {
  static Process? _serverProcess;
  static final Dio _pingDio = Dio(BaseOptions(
    connectTimeout: const Duration(milliseconds: 800),
    receiveTimeout: const Duration(milliseconds: 800),
  ));

  static Future<bool> isServerRunning() async {
    try {
      final response = await _pingDio.get('http://127.0.0.1:10086/server/now');
      return response.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  static Future<void> killPort() async {
    try {
      if (Platform.isWindows) {
        // 使用同步执行确保在启动新进程前，旧进程已经被标记清理
        // 限制在 1.5 秒内，防止挂死
        await Process.run('taskkill', ['/F', '/IM', 'app_win.exe', '/T'])
            .timeout(const Duration(milliseconds: 1500));
        // 给系统一点点时间释放句柄
        await Future.delayed(const Duration(milliseconds: 200));
      } else {
        final result = await Process.run('lsof', ['-ti', ':10086'])
            .timeout(const Duration(seconds: 1));
        final pid = result.stdout.toString().trim();
        if (pid.isNotEmpty) {
          await Process.run('kill', ['-9', pid]);
        }
      }
    } catch (e) {
      // 忽略清理错误
    }
  }

  static Future<bool> start() async {
    if (_serverProcess != null) return true;

    // 重要：如果已经有服务器在跑且正常，绝对不要执行任何清理或重启逻辑
    if (await isServerRunning()) {
      LoggerService.i('[Server] Active server detected. Reusing existing instance.');
      return true;
    }

    LoggerService.i('[Server] No active server. Cleaning up and starting new...');
    await killPort();

    try {
      final args = ['--port=10086', '--platform=lite', '--host=0.0.0.0'];
      
      if (kDebugMode) {
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
          _serverProcess = await Process.start(
            npmCmd, 
            ['start', '--', ...args], 
            workingDirectory: serverDir
          );
        }
      } else {
        final executableName = Platform.isWindows ? 'app_win.exe' : (Platform.isMacOS ? 'app_macos' : 'app_linux');
        final appDir = p.dirname(Platform.resolvedExecutable);
        String serverPath = Platform.isMacOS 
            ? p.join(appDir, '..', 'Resources', 'server', executableName)
            : p.join(appDir, 'server', executableName);

        if (File(serverPath).existsSync()) {
          LoggerService.i('[Server] Launching: $serverPath');
          // 修复关键：显式指定 workingDirectory 为可执行文件所在目录
          _serverProcess = await Process.start(
            serverPath, 
            args,
            workingDirectory: p.dirname(serverPath)
          );
        } else {
          LoggerService.e('[Server] Binary MISSING at $serverPath');
        }
      }

      if (_serverProcess == null) return false;

      _serverProcess?.stdout.listen((data) => LoggerService.d('[Server] ${utf8.decode(data, allowMalformed: true).trim()}'));
      _serverProcess?.stderr.listen((data) => LoggerService.e('[Server] ${utf8.decode(data, allowMalformed: true).trim()}'));

      // 健康检查，由于我们指定了工作目录，启动速度应该会变快
      for (int i = 0; i < 20; i++) {
        await Future.delayed(const Duration(milliseconds: 500));
        if (await isServerRunning()) {
          LoggerService.i('[Server] Server is UP and healthy.');
          return true;
        }
      }
    } catch (e) {
      LoggerService.e('[Server] Unexpected failure during startup', e);
    }

    return false;
  }

  static void stop() {
    _serverProcess?.kill();
    _serverProcess = null;
    // 退出时不再暴力 taskkill，由操作系统回收
  }
}
