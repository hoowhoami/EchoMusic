import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:path/path.dart' as p;
import 'package:dio/dio.dart';

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
    debugPrint('[Server] Attempting to kill port 10086...');
    try {
      if (Platform.isWindows) {
        final result = await Process.run('cmd', ['/c', 'netstat -ano | findstr :10086']);
        final output = result.stdout.toString();
        if (output.isNotEmpty) {
          final lines = output.split('\r\n');
          for (var line in lines) {
            final parts = line.trim().split(RegExp(r'\s+'));
            if (parts.length >= 5) {
              final pid = parts.last;
              await Process.run('taskkill', ['/F', '/PID', pid]);
              debugPrint('[Server] Killed Windows process $pid');
            }
          }
        }
      } else {
        final result = await Process.run('lsof', ['-ti', ':10086']);
        final pid = result.stdout.toString().trim();
        if (pid.isNotEmpty) {
          await Process.run('kill', ['-9', pid]);
          debugPrint('[Server] Killed Unix process $pid');
        }
      }
    } catch (e) {
      debugPrint('[Server] Error killing port: $e');
    }
  }

  static Future<bool> start() async {
    if (_serverProcess != null) return true;

    debugPrint('[Server] Checking if server is already running...');
    if (await isServerRunning()) {
      debugPrint('[Server] Server is already running on port 10086');
      return true;
    }

    String? serverDir;
    final args = ['--port=10086', '--platform=lite', '--host=0.0.0.0'];
    
    if (kDebugMode) {
      debugPrint('[Server] Debug mode detected. Finding server directory...');
      // Use Platform.resolvedExecutable as a more reliable anchor in macOS Sandbox
      // Typically: /Project/build/macos/Build/Products/Debug/app.app/Contents/MacOS/app
      Directory anchorDir = Directory(p.dirname(Platform.resolvedExecutable));
      debugPrint('[Server] Starting search from executable dir: ${anchorDir.path}');
      
      for (int i = 0; i < 10; i++) {
        final potential = p.join(anchorDir.path, 'server');
        if (Directory(potential).existsSync() && File(p.join(potential, 'package.json')).existsSync()) {
          serverDir = potential;
          break;
        }
        // Also check if we are in the project root directly (some IDEs start here)
        final rootPotential = p.join(Directory.current.path, 'server');
        if (Directory(rootPotential).existsSync() && File(p.join(rootPotential, 'package.json')).existsSync()) {
          serverDir = rootPotential;
          break;
        }
        anchorDir = anchorDir.parent;
        if (anchorDir.path == anchorDir.parent.path) break; // Reached root
      }
      
      if (serverDir != null) {
        debugPrint('[Server] Found server directory at: $serverDir');
        final nodeModules = Directory(p.join(serverDir, 'node_modules'));
        final npmCmd = Platform.isWindows ? 'npm.cmd' : 'npm';

        if (!nodeModules.existsSync()) {
          debugPrint('[Server] node_modules not found. Running npm install...');
          final installResult = await Process.run(
            npmCmd, 
            ['install'], 
            workingDirectory: serverDir
          );
          if (installResult.exitCode != 0) {
            debugPrint('[Server] npm install failed: ${installResult.stderr}');
            return false;
          }
          debugPrint('[Server] npm install completed.');
        }

        debugPrint('[Server] Starting server via npm start...');
        _serverProcess = await Process.start(
          npmCmd,
          ['start', '--', ...args],
          workingDirectory: serverDir,
        );
      } else {
        debugPrint('[Server] ERROR: Could not find server directory in project structure!');
        return false;
      }
    } else {
      final executableName = Platform.isWindows ? 'app_win.exe' : (Platform.isMacOS ? 'app_macos' : 'app_linux');
      final appDir = p.dirname(Platform.resolvedExecutable);
      String serverPath = Platform.isMacOS 
          ? p.join(appDir, '..', 'Resources', 'server', executableName)
          : p.join(appDir, 'server', executableName);

      if (File(serverPath).existsSync()) {
        debugPrint('[Server] Starting production executable: $serverPath');
        _serverProcess = await Process.start(serverPath, args);
      }
    }

    if (_serverProcess == null) return false;

    _serverProcess?.stdout.listen((data) => debugPrint('[Server LOG] ${String.fromCharCodes(data).trim()}'));
    _serverProcess?.stderr.listen((data) => debugPrint('[Server ERR] ${String.fromCharCodes(data).trim()}'));

    debugPrint('[Server] Waiting for health check...');
    for (int i = 0; i < 20; i++) {
      await Future.delayed(const Duration(milliseconds: 500));
      if (await isServerRunning()) return true;
    }

    debugPrint('[Server] ERROR: Timeout waiting for server.');
    return false;
  }

  static void stop() {
    if (_serverProcess != null) {
      debugPrint('[Server] Stopping server process...');
      _serverProcess?.kill();
      _serverProcess = null;
    }
    killPort();
  }
}