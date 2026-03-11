import 'dart:async';
import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:path/path.dart' as p;
import 'package:dio/dio.dart';
import 'logger.dart';

class ServerOrchestrator {
  static Process? _serverProcess;
  static bool _isStarting = false;
  static bool _serverReady = false;

  static final Dio _pingDio = Dio(
    BaseOptions(
      connectTimeout: const Duration(milliseconds: 2000),
      receiveTimeout: const Duration(milliseconds: 2000),
    ),
  );

  static bool get isReady => _serverReady;

  /// Waits until the server is ready, or until [timeout] elapses.
  /// Returns true if the server became ready, false if timed out.
  static Future<bool> waitUntilReady({
    Duration timeout = const Duration(seconds: 60),
  }) async {
    if (_serverReady) return true;
    final deadline = DateTime.now().add(timeout);
    while (DateTime.now().isBefore(deadline)) {
      await Future.delayed(const Duration(milliseconds: 300));
      if (_serverReady) return true;
    }
    return false;
  }

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
      await Future.delayed(
        Duration(milliseconds: Platform.isWindows ? 1500 : 500),
      );

      final args = ['--port=10086', '--platform=lite', '--host=0.0.0.0'];

      if (kDebugMode) {
        // Debug mode: use npm start
        String? serverDir = _findServerDir();
        if (serverDir != null) {
          final npmCmd = Platform.isWindows ? 'npm.cmd' : 'npm';

          // Run npm install to ensure dependencies are up to date
          LoggerService.i('[Server] Running npm install...');
          final installResult = await Process.run(npmCmd, [
            'install',
          ], workingDirectory: serverDir);
          if (installResult.exitCode != 0) {
            LoggerService.e(
              '[Server] npm install failed: ${installResult.stderr}',
            );
            _isStarting = false;
            return false;
          }
          LoggerService.i('[Server] npm install completed');

          LoggerService.i('[Server] Starting debug server in $serverDir');
          _serverProcess = await Process.start(
            npmCmd,
            ['start', '--', ...args],
            workingDirectory: serverDir,
            mode: ProcessStartMode.detached,
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

        LoggerService.i(
          '[Server] Launching production server from: ${p.dirname(serverPath)}',
        );

        // Release mode: use detached (no stdio pipes) on all platforms.
        // The server process gets no stdout/stderr handles, so the Node.js/libuv
        // runtime never interacts with the OS console subsystem during startup,
        // eliminating the synchronous I/O stutter seen with detachedWithStdio.
        // Readiness is detected via HTTP health-check polling.
        _serverProcess = await Process.start(
          serverPath,
          args,
          workingDirectory: p.dirname(serverPath),
          mode: ProcessStartMode.detached,
        );
      }

      if (_serverProcess == null) {
        _isStarting = false;
        return false;
      }

      bool completed = false;

      // Poll via HTTP until the server responds or we time out (30 s).
      final startTime = DateTime.now();
      while (!completed &&
          DateTime.now().difference(startTime).inSeconds < 30) {
        await Future.delayed(const Duration(milliseconds: 500));

        if (await isServerRunning()) {
          LoggerService.i('[Server] Health check passed');
          completed = true;
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
    LoggerService.i(
      '[Server] Forcing cleanup of any existing server process...',
    );
    try {
      if (Platform.isWindows) {
        // Kill by process name — sufficient since port 10086 is exclusively
        // used by app_win.exe. No need for a secondary port-based lookup.
        await Process.run('taskkill', [
          '/F',
          '/IM',
          'app_win.exe',
          '/T',
        ]).timeout(
          const Duration(seconds: 3),
          onTimeout: () => ProcessResult(0, 1, '', ''),
        );
      } else {
        // macOS/Linux: kill by port
        final pids = await _findPidsListeningOnPort(10086);
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

  static Future<List<String>> _findPidsListeningOnPort(int port) async {
    Future<List<String>> runPidLookup(String command, List<String> args) async {
      final result = await Process.run(command, args).timeout(
        const Duration(seconds: 2),
        onTimeout: () => ProcessResult(0, 1, '', ''),
      );
      return result.stdout
          .toString()
          .split(RegExp(r'[\s\n]+'))
          .map((pid) => pid.trim())
          .where((pid) => RegExp(r'^[0-9]+$').hasMatch(pid))
          .toList();
    }

    Future<bool> commandExists(String command) async {
      try {
        final result =
            await Process.run('/bin/sh', [
              '-c',
              'command -v $command >/dev/null 2>&1',
            ]).timeout(
              const Duration(seconds: 2),
              onTimeout: () => ProcessResult(0, 1, '', ''),
            );
        return result.exitCode == 0;
      } catch (_) {
        return false;
      }
    }

    if (await commandExists('lsof')) {
      return runPidLookup('lsof', ['-ti', ':$port']);
    }

    if (Platform.isLinux && await commandExists('fuser')) {
      return runPidLookup('fuser', ['$port/tcp']);
    }

    LoggerService.d(
      '[Server] Port cleanup skipped: no supported port lookup tool found',
    );
    return const [];
  }

  static Future<void> stop({String reason = 'unspecified'}) async {
    final process = _serverProcess;
    final pid = process?.pid;

    if (process != null) {
      _serverProcess = null;
      try {
        if (Platform.isWindows) {
          await Process.run('taskkill', [
            '/F',
            '/T',
            '/PID',
            '$pid',
          ]);
        } else {
          process.kill(ProcessSignal.sigkill);
        }
      } catch (e, stackTrace) {
        LoggerService.e(
          '[Server] Error stopping process for pid=${pid ?? 'n/a'} (reason=$reason)',
          e,
          stackTrace,
        );
      }
    }

    _serverReady = false;
  }
}
