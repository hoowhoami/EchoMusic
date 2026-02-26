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

  static Future<void> killPort() async {
    LoggerService.i('[Server] Checking if port 10086 is occupied...');
    try {
      if (Platform.isWindows) {
        // Direct execution of netstat to avoid cmd shell issues
        final result = await Process.run('netstat', ['-ano']).timeout(
          const Duration(seconds: 2),
          onTimeout: () => ProcessResult(0, 0, '', 'Timeout'),
        );
        
        final output = result.stdout.toString();
        if (output.isNotEmpty) {
          final lines = output.split('\n');
          for (var line in lines) {
            if (line.contains(':10086')) {
              final parts = line.trim().split(RegExp(r'\s+'));
              if (parts.isNotEmpty) {
                final pid = parts.last;
                if (int.tryParse(pid) != null && pid != '0') {
                  LoggerService.i('[Server] Found process $pid on port 10086. Killing...');
                  await Process.run('taskkill', ['/F', '/PID', pid]);
                }
              }
            }
          }
        }
      } else {
        final result = await Process.run('lsof', ['-ti', ':10086']).timeout(
          const Duration(seconds: 2),
          onTimeout: () => ProcessResult(0, 0, '', 'Timeout'),
        );
        final pid = result.stdout.toString().trim();
        if (pid.isNotEmpty) {
          await Process.run('kill', ['-9', pid]);
          LoggerService.i('[Server] Killed Unix process $pid');
        }
      }
    } catch (e) {
      LoggerService.e('[Server] Error during port cleanup', e);
    }
  }

  static Future<bool> start() async {
    if (_serverProcess != null) return true;

    LoggerService.i('[Server] Pre-start cleanup...');
    await killPort();

    String? serverDir;
    final args = ['--port=10086', '--platform=lite', '--host=0.0.0.0'];
    
    try {
      if (kDebugMode) {
        LoggerService.i('[Server] Debug mode detected. Finding server directory...');
        Directory anchorDir = Directory(p.dirname(Platform.resolvedExecutable));
        
        for (int i = 0; i < 10; i++) {
          final potential = p.join(anchorDir.path, 'server');
          if (Directory(potential).existsSync() && File(p.join(potential, 'package.json')).existsSync()) {
            serverDir = potential;
            break;
          }
          final rootPotential = p.join(Directory.current.path, 'server');
          if (Directory(rootPotential).existsSync() && File(p.join(rootPotential, 'package.json')).existsSync()) {
            serverDir = rootPotential;
            break;
          }
          anchorDir = anchorDir.parent;
          if (anchorDir.path == anchorDir.parent.path) break;
        }
        
        if (serverDir != null) {
          LoggerService.i('[Server] Found server directory at: $serverDir');
          final nodeModules = Directory(p.join(serverDir, 'node_modules'));
          final npmCmd = Platform.isWindows ? 'npm.cmd' : 'npm';

          if (!nodeModules.existsSync()) {
            LoggerService.i('[Server] node_modules not found. Running npm install...');
            final installResult = await Process.run(
              npmCmd, 
              ['install'], 
              workingDirectory: serverDir
            );
            if (installResult.exitCode != 0) {
              LoggerService.e('[Server] npm install failed: ${installResult.stderr}');
              return false;
            }
          }

          _serverProcess = await Process.start(
            npmCmd,
            ['start', '--', ...args],
            workingDirectory: serverDir,
          );
        } else {
          LoggerService.e('[Server] ERROR: Could not find server directory!');
          return false;
        }
      } else {
        final executableName = Platform.isWindows ? 'app_win.exe' : (Platform.isMacOS ? 'app_macos' : 'app_linux');
        final appDir = p.dirname(Platform.resolvedExecutable);
        String serverPath = Platform.isMacOS 
            ? p.join(appDir, '..', 'Resources', 'server', executableName)
            : p.join(appDir, 'server', executableName);

        if (File(serverPath).existsSync()) {
          LoggerService.i('[Server] Starting production executable: $serverPath');
          _serverProcess = await Process.start(serverPath, args);
        } else {
          LoggerService.e('[Server] ERROR: Server binary not found at $serverPath');
        }
      }

      if (_serverProcess == null) return false;

      _serverProcess?.stdout.listen((data) {
        final msg = utf8.decode(data, allowMalformed: true).trim();
        if (msg.isNotEmpty) LoggerService.d('[Server] $msg');
      });
      _serverProcess?.stderr.listen((data) {
        final msg = utf8.decode(data, allowMalformed: true).trim();
        if (msg.isNotEmpty) LoggerService.e('[Server] $msg');
      });

      LoggerService.i('[Server] Waiting for health check...');
      for (int i = 0; i < 20; i++) {
        await Future.delayed(const Duration(milliseconds: 500));
        if (await isServerRunning()) return true;
      }
    } catch (e) {
      LoggerService.e('[Server] Unexpected crash during startup', e);
      return false;
    }

    LoggerService.e('[Server] ERROR: Timeout waiting for server.');
    return false;
  }

  static void stop() {
    if (_serverProcess != null) {
      LoggerService.i('[Server] Stopping server process...');
      _serverProcess?.kill();
      _serverProcess = null;
    }
    killPort();
  }
}
