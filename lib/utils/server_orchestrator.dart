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
    LoggerService.i('[Server] Forcing cleanup of any existing server process...');
    try {
      if (Platform.isWindows) {
        // 直接按进程名强制杀死，确保干净
        await Process.run('taskkill', ['/F', '/IM', 'app_win.exe', '/T'])
            .timeout(const Duration(milliseconds: 2000));
      } else {
        final result = await Process.run('lsof', ['-ti', ':10086'])
            .timeout(const Duration(seconds: 1));
        final pid = result.stdout.toString().trim();
        if (pid.isNotEmpty) {
          await Process.run('kill', ['-9', pid]);
        }
      }
    } catch (e) {
      // 忽略可能的错误（如进程本身就不存在）
    }
  }

  static Future<bool> start() async {
    if (_serverProcess != null) return true;

    // 1. 彻底清场
    await killPort();
    // 2. 强制等待 500ms，确保操作系统释放端口
    await Future.delayed(const Duration(milliseconds: 500));

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
          LoggerService.i('[Server] Starting debug server in $serverDir');
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
          LoggerService.i('[Server] Launching production server from: ${p.dirname(serverPath)}');
          // 显式指定工作目录，确保后端程序能找到同目录资源
          _serverProcess = await Process.start(
            serverPath, 
            args,
            workingDirectory: p.dirname(serverPath)
          );
        } else {
          LoggerService.e('[Server] Binary not found at $serverPath');
        }
      }

      if (_serverProcess == null) return false;

      _serverProcess?.stdout.listen((data) => LoggerService.d('[Server] ${utf8.decode(data, allowMalformed: true).trim()}'));
      _serverProcess?.stderr.listen((data) => LoggerService.e('[Server] ${utf8.decode(data, allowMalformed: true).trim()}'));

      // 3. 健康检查
      for (int i = 0; i < 20; i++) {
        await Future.delayed(const Duration(milliseconds: 500));
        if (await isServerRunning()) {
          LoggerService.i('[Server] Server is now UP and responsive.');
          return true;
        }
      }
    } catch (e) {
      LoggerService.e('[Server] Unexpected crash during start phase', e);
    }

    return false;
  }

  static void stop() {
    _serverProcess?.kill();
    _serverProcess = null;
    killPort();
  }
}
