import 'dart:async';
import 'dart:io';
import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:path/path.dart' as p;
import 'package:dio/dio.dart';
import 'logger.dart';

class ServerOrchestrator {
  static Process? _serverProcess;
  static bool _isStarting = false;
  static bool _serverReady = false;

  static final Dio _pingDio = Dio(BaseOptions(
    connectTimeout: const Duration(milliseconds: 2000),
    receiveTimeout: const Duration(milliseconds: 2000),
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
    // Don't kill if server is already running and ready
    if (_serverReady && _serverProcess != null) {
      LoggerService.i('[Server] Server is running, skipping killPort');
      return;
    }
    await _forceKillPort();
  }

  static Future<bool> start() async {
    // If server is already ready, verify it's still running
    if (_serverReady && _serverProcess != null) {
      if (await isServerRunning()) {
        LoggerService.i('[Server] Server already running and ready');
        return true;
      }
      // Server died, reset state
      _serverReady = false;
      _serverProcess = null;
    }

    // Prevent concurrent start attempts
    if (_isStarting) {
      LoggerService.i('[Server] Server start already in progress, waiting...');
      for (int i = 0; i < 60; i++) {
        await Future.delayed(const Duration(milliseconds: 500));
        if (_serverReady) return true;
        if (!_isStarting) break;
      }
      return _serverReady;
    }

    _isStarting = true;
    _serverReady = false;

    try {
      // 1. Kill any existing process on the port
      await _forceKillPort();

      // 2. Wait for port to be released (Windows needs more time)
      await Future.delayed(Duration(milliseconds: Platform.isWindows ? 1500 : 500));

      final args = ['--port=10086', '--platform=lite', '--host=0.0.0.0'];

      if (kDebugMode) {
        // Debug mode: use npm start
        String? serverDir = _findServerDir();
        if (serverDir != null) {
          final npmCmd = Platform.isWindows ? 'npm.cmd' : 'npm';

          // Run npm install to ensure dependencies are up to date
          LoggerService.i('[Server] Running npm install...');
          final installResult = await Process.run(
            npmCmd,
            ['install'],
            workingDirectory: serverDir,
          );
          if (installResult.exitCode != 0) {
            LoggerService.e('[Server] npm install failed: ${installResult.stderr}');
            _isStarting = false;
            return false;
          }
          LoggerService.i('[Server] npm install completed');

          LoggerService.i('[Server] Starting debug server in $serverDir');
          _serverProcess = await Process.start(
            npmCmd,
            ['start', '--', ...args],
            workingDirectory: serverDir,
            mode: ProcessStartMode.normal,
          );
        } else {
          LoggerService.e('[Server] Server directory not found in debug mode');
          _isStarting = false;
          return false;
        }
      } else {
        // Release mode: use compiled binary
        final serverPath = _getServerExecutablePath();
        if (serverPath == null || !File(serverPath).existsSync()) {
          LoggerService.e('[Server] Binary not found at $serverPath');
          _isStarting = false;
          return false;
        }

        LoggerService.i('[Server] Launching production server from: ${p.dirname(serverPath)}');

        _serverProcess = await Process.start(
          serverPath,
          args,
          workingDirectory: p.dirname(serverPath),
          mode: ProcessStartMode.normal,
        );
      }

      if (_serverProcess == null) {
        _isStarting = false;
        return false;
      }

      // Use Completer to wait for server ready signal from stdout
      final completer = Completer<bool>();
      bool completed = false;

      // Listen to stdout for "running" signal (like the reference project)
      _serverProcess!.stdout.transform(utf8.decoder).listen((data) {
        final output = data.trim();
        if (output.isNotEmpty) {
          LoggerService.d('[Server] $output');
        }
        // Check for server ready signal
        if (!completed && (output.contains('running') || output.contains('listening') || output.contains('started'))) {
          LoggerService.i('[Server] Detected server ready signal in stdout');
          completed = true;
          if (!completer.isCompleted) {
            completer.complete(true);
          }
        }
      });

      _serverProcess!.stderr.transform(utf8.decoder).listen((data) {
        final output = data.trim();
        if (output.isNotEmpty) {
          LoggerService.e('[Server] $output');
        }
      });

      // Handle process exit
      _serverProcess!.exitCode.then((code) {
        LoggerService.i('[Server] Process exited with code: $code');
        if (!completed && !completer.isCompleted) {
          completer.complete(false);
        }
        if (code != 0) {
          _serverReady = false;
          _serverProcess = null;
        }
      });

      // Wait for either: stdout signal, timeout, or health check success
      // Timeout after 30 seconds
      final startTime = DateTime.now();
      while (!completed && DateTime.now().difference(startTime).inSeconds < 30) {
        await Future.delayed(const Duration(milliseconds: 500));

        // Also try health check as backup
        if (await isServerRunning()) {
          LoggerService.i('[Server] Health check passed');
          completed = true;
          if (!completer.isCompleted) {
            completer.complete(true);
          }
          break;
        }
      }

      if (completed || await isServerRunning()) {
        LoggerService.i('[Server] Server is now UP and responsive.');
        _serverReady = true;
        _isStarting = false;
        return true;
      }

      LoggerService.e('[Server] Timeout waiting for server to start');
      _isStarting = false;
      return false;

    } catch (e, stack) {
      LoggerService.e('[Server] Unexpected crash during start phase', e, stack);
      _isStarting = false;
      return false;
    }
  }

  static String? _findServerDir() {
    Directory anchorDir = Directory(p.dirname(Platform.resolvedExecutable));
    for (int i = 0; i < 10; i++) {
      final potential = p.join(anchorDir.path, 'server');
      if (Directory(potential).existsSync() &&
          File(p.join(potential, 'package.json')).existsSync()) {
        return potential;
      }
      anchorDir = anchorDir.parent;
    }
    return null;
  }

  static String? _getServerExecutablePath() {
    final appDir = p.dirname(Platform.resolvedExecutable);
    String executableName;
    String serverPath;

    if (Platform.isWindows) {
      executableName = 'app_win.exe';
      serverPath = p.join(appDir, 'server', executableName);
    } else if (Platform.isMacOS) {
      executableName = 'app_macos';
      // macOS: binary is in Resources folder
      serverPath = p.join(appDir, '..', 'Resources', 'server', executableName);
    } else if (Platform.isLinux) {
      executableName = 'app_linux';
      serverPath = p.join(appDir, 'server', executableName);
    } else {
      return null;
    }

    return serverPath;
  }

  static Future<void> _forceKillPort() async {
    LoggerService.i('[Server] Forcing cleanup of any existing server process...');
    try {
      if (Platform.isWindows) {
        // Kill by process name
        await Process.run('taskkill', ['/F', '/IM', 'app_win.exe', '/T'])
            .timeout(const Duration(seconds: 3));
        // Also try to kill by port using PowerShell (more reliable)
        try {
          await Process.run('powershell', [
            '-Command',
            "Get-NetTCPConnection -LocalPort 10086 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id \$_.OwningProcess -Force -ErrorAction SilentlyContinue }"
          ]).timeout(const Duration(seconds: 3));
        } catch (_) {}
      } else {
        // macOS/Linux: kill by port
        final result = await Process.run('lsof', ['-ti', ':10086'])
            .timeout(const Duration(seconds: 2));
        final pids = result.stdout.toString().trim().split('\n');
        for (final pid in pids) {
          if (pid.isNotEmpty) {
            await Process.run('kill', ['-9', pid]);
          }
        }
      }
    } catch (e) {
      // Ignore errors (process might not exist)
      LoggerService.d('[Server] Kill cleanup: $e');
    }
  }

  static void stop() {
    if (_serverProcess != null) {
      LoggerService.i('[Server] Stopping server process...');
      try {
        if (Platform.isWindows) {
          // Windows: use taskkill for clean shutdown
          Process.run('taskkill', ['/F', '/T', '/PID', '${_serverProcess!.pid}']);
        } else {
          _serverProcess!.kill(ProcessSignal.sigkill);
        }
      } catch (e) {
        LoggerService.e('[Server] Error stopping process: $e');
      }
      _serverProcess = null;
    }
    _serverReady = false;
    _forceKillPort();
  }
}
