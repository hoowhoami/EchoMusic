import 'dart:io';
import 'package:flutter/foundation.dart';
import '../api/backend/library/kugou_bridge.dart';
import 'server_orchestrator.dart';
import 'logger.dart';

enum MusicServerRuntimeMode { http, library }

abstract class MusicServerRuntime {
  Future<bool> start();
  Future<void> stop();
  Future<bool> restart();
  Future<bool> ensureReady({Duration timeout = const Duration(seconds: 60)});
  bool get isReady;
  String? get lastError;
}

class HttpMusicServerRuntime implements MusicServerRuntime {
  String? _lastError;

  @override
  Future<bool> start() async {
    final success = await ServerOrchestrator.start();
    _lastError = success ? null : 'HTTP server failed to start';
    return success;
  }

  @override
  Future<void> stop() async {
    ServerOrchestrator.stop();
    _lastError = null;
  }

  @override
  Future<bool> restart() async {
    stop();
    await Future.delayed(const Duration(milliseconds: 500));
    return await start();
  }

  @override
  Future<bool> ensureReady({
    Duration timeout = const Duration(seconds: 60),
  }) async {
    return await ServerOrchestrator.waitUntilReady(timeout: timeout);
  }

  @override
  bool get isReady => ServerOrchestrator.isReady;

  @override
  String? get lastError => _lastError;
}

class LibraryMusicServerRuntime implements MusicServerRuntime {
  bool _isReady = false;
  String? _lastError;
  String? _resolvedLibraryDir;

  @override
  Future<bool> start() async {
    _lastError = null;
    _resolvedLibraryDir = _resolveBuildPlan()?.libraryDir;

    if (kDebugMode) {
      final checkResult = await _checkOrBuildNativeLibraries();
      if (!checkResult) {
        LoggerService.e(
          '[LibraryRuntime] Native library check failed: $_lastError',
        );
        return false;
      }
    }

    try {
      final bridgeProbe = KugouMusicApiBridge(libraryDir: _resolvedLibraryDir);
      bridgeProbe.disposeSync();
      LoggerService.i(
        '[LibraryRuntime] Library runtime initialized${_resolvedLibraryDir == null ? '' : ' ($_resolvedLibraryDir)'}',
      );
      _isReady = true;
      return true;
    } catch (e, stack) {
      _lastError = 'Failed to initialize native bridge: $e';
      LoggerService.e('[LibraryRuntime] $_lastError', e, stack);
      return false;
    }
  }

  @override
  Future<void> stop() async {
    _isReady = false;
    LoggerService.i('[LibraryRuntime] Library runtime stopped');
  }

  @override
  Future<bool> restart() async {
    await stop();
    await Future.delayed(const Duration(milliseconds: 100));
    return await start();
  }

  @override
  Future<bool> ensureReady({
    Duration timeout = const Duration(seconds: 60),
  }) async {
    if (_isReady) return true;

    final deadline = DateTime.now().add(timeout);
    while (DateTime.now().isBefore(deadline)) {
      await Future.delayed(const Duration(milliseconds: 300));
      if (_isReady) return true;
    }
    return false;
  }

  @override
  bool get isReady => _isReady;

  @override
  String? get lastError => _lastError;

  Future<bool> _checkOrBuildNativeLibraries() async {
    try {
      final serverLibraryDir = Directory('server_library');
      if (!serverLibraryDir.existsSync()) {
        _lastError = 'server_library directory not found';
        return false;
      }

      final buildPlan = _resolveBuildPlan();
      if (buildPlan == null) {
        _lastError = 'Unsupported platform for native library';
        return false;
      }

      final missingInputs = buildPlan.requiredPaths
          .where(
            (path) =>
                FileSystemEntity.typeSync(path) ==
                FileSystemEntityType.notFound,
          )
          .toList();
      if (missingInputs.isNotEmpty) {
        _lastError =
            'server_library is incomplete. Missing: ${missingInputs.join(', ')}';
        return false;
      }

      if (!kReleaseMode) {
        final buildResult = await _buildNativeLibraries(buildPlan);
        if (!buildResult) {
          return false;
        }
      }

      for (final libPath in buildPlan.libraryPaths) {
        if (!File(libPath).existsSync()) {
          _lastError = 'Native library not found at $libPath after build.';
          return false;
        }
      }

      LoggerService.i(
        '[LibraryRuntime] Native library check passed: ${buildPlan.libraryDir}',
      );
      _resolvedLibraryDir = buildPlan.libraryDir;
      return true;
    } catch (e, stack) {
      _lastError = 'Native library check error: $e';
      LoggerService.e('[LibraryRuntime] $_lastError', e, stack);
      return false;
    }
  }

  Future<bool> _buildNativeLibraries(_LibraryBuildPlan buildPlan) async {
    LoggerService.i(
      '[LibraryRuntime] Building server_library with ${buildPlan.configurePreset} / ${buildPlan.buildPreset}',
    );

    final pnpmInstallResult = await _runBuildStep(
      command: 'pnpm',
      arguments: const ['i'],
      failurePrefix: 'pnpm install failed',
    );
    if (!pnpmInstallResult) {
      return false;
    }

    final pullNcmResult = await _runBuildStep(
      command: 'node',
      arguments: const ['scripts/pull_ncm.js'],
      failurePrefix: 'pull_ncm failed',
    );
    if (!pullNcmResult) {
      return false;
    }

    final webpackResult = await _runBuildStep(
      command: 'npx',
      arguments: const ['webpack'],
      failurePrefix: 'webpack build failed',
    );
    if (!webpackResult) {
      return false;
    }

    final configureResult = await _runBuildStep(
      command: 'cmake',
      arguments: ['--preset', buildPlan.configurePreset],
      failurePrefix: 'cmake configure failed',
    );
    if (!configureResult) {
      return false;
    }

    final qjscBuildResult = await _runBuildStep(
      command: 'cmake',
      arguments: [
        '--build',
        '--preset',
        buildPlan.buildPreset,
        '--target',
        'qjsc',
      ],
      failurePrefix: 'cmake build qjsc failed',
    );
    if (!qjscBuildResult) {
      return false;
    }

    final buildResult = await _runBuildStep(
      command: 'cmake',
      arguments: ['--build', '--preset', buildPlan.buildPreset],
      failurePrefix: 'cmake build failed',
    );
    if (!buildResult) {
      return false;
    }

    return true;
  }

  Future<bool> _runBuildStep({
    required String command,
    required List<String> arguments,
    required String failurePrefix,
  }) async {
    final result = await Process.run(
      command,
      arguments,
      workingDirectory: 'server_library',
    );
    if (result.exitCode == 0) {
      return true;
    }

    _lastError = _formatBuildFailure(
      failurePrefix,
      result.stderr,
      result.stdout,
    );
    return false;
  }

  String _formatBuildFailure(String prefix, dynamic stderr, dynamic stdout) {
    final stderrText = stderr?.toString().trim() ?? '';
    final stdoutText = stdout?.toString().trim() ?? '';
    final detail = stderrText.isNotEmpty ? stderrText : stdoutText;
    if (detail.isEmpty) {
      return prefix;
    }
    return '$prefix: ${detail.split('\n').take(6).join(' | ')}';
  }

  String _getMacOSArch() {
    // Detect architecture
    try {
      final result = Process.runSync('uname', ['-m']);
      final arch = result.stdout.toString().trim();
      if (arch == 'arm64') return 'arm64';
      return 'x64';
    } catch (_) {
      return 'x64'; // fallback
    }
  }

  _LibraryBuildPlan? _resolveBuildPlan() {
    if (Platform.isMacOS) {
      final arch = _getMacOSArch();
      final configurePreset = 'macos-$arch-clang';
      final buildPreset = '$configurePreset-Release';
      final libraryDir =
          'server_library/build/macos/$arch/$configurePreset/Release/lib';
      final absoluteLibraryDir = Directory(libraryDir).absolute.path;
      return _LibraryBuildPlan(
        configurePreset: configurePreset,
        buildPreset: buildPreset,
        libraryDir: absoluteLibraryDir,
        libraryPaths: [
          '$absoluteLibraryDir/libengine.dylib',
          '$absoluteLibraryDir/libkugou_music_api.dylib',
        ],
        requiredPaths: const [
          'server_library/CMakeLists.txt',
          'server_library/CMakePresets.json',
          'server_library/src/c/engine.c',
          'server_library/src/c/kugou/main.c',
          'server_library/src/include/engine.h',
          'server_library/src/include/kugou_music_api.h',
        ],
      );
    }

    if (Platform.isLinux) {
      const configurePreset = 'linux-x64-gcc';
      const buildPreset = 'linux-x64-gcc-Release';
      const libraryDir =
          'server_library/build/linux/x64/linux-x64-gcc/Release/lib';
      final absoluteLibraryDir = Directory(libraryDir).absolute.path;
      return _LibraryBuildPlan(
        configurePreset: configurePreset,
        buildPreset: buildPreset,
        libraryDir: absoluteLibraryDir,
        libraryPaths: [
          '$absoluteLibraryDir/libengine.so',
          '$absoluteLibraryDir/libkugou_music_api.so',
        ],
        requiredPaths: [
          'server_library/CMakeLists.txt',
          'server_library/CMakePresets.json',
          'server_library/src/c/engine.c',
          'server_library/src/c/kugou/main.c',
          'server_library/src/include/engine.h',
          'server_library/src/include/kugou_music_api.h',
        ],
      );
    }

    return null;
  }
}

class _LibraryBuildPlan {
  const _LibraryBuildPlan({
    required this.configurePreset,
    required this.buildPreset,
    required this.libraryDir,
    required this.libraryPaths,
    required this.requiredPaths,
  });

  final String configurePreset;
  final String buildPreset;
  final String libraryDir;
  final List<String> libraryPaths;
  final List<String> requiredPaths;
}

class MusicServerRuntimeController {
  static MusicServerRuntime? _currentRuntime;
  static MusicServerRuntimeMode _currentMode = MusicServerRuntimeMode.http;

  static MusicServerRuntime get current {
    _currentRuntime ??= _createRuntime(_currentMode);
    return _currentRuntime!;
  }

  static MusicServerRuntimeMode get currentMode => _currentMode;

  static Future<void> setMode(MusicServerRuntimeMode mode) async {
    if (_currentMode == mode && _currentRuntime != null) {
      return;
    }

    if (_currentRuntime != null) {
      await _currentRuntime!.stop();
    }

    _currentMode = mode;
    _currentRuntime = _createRuntime(mode);
  }

  static MusicServerRuntime _createRuntime(MusicServerRuntimeMode mode) {
    switch (mode) {
      case MusicServerRuntimeMode.http:
        return HttpMusicServerRuntime();
      case MusicServerRuntimeMode.library:
        return LibraryMusicServerRuntime();
    }
  }

  static Future<bool> start() => current.start();
  static Future<void> stop() => current.stop();
  static Future<bool> restart() => current.restart();
  static Future<bool> ensureReady({
    Duration timeout = const Duration(seconds: 60),
  }) => current.ensureReady(timeout: timeout);
  static bool get isReady => current.isReady;
  static String? get lastError => current.lastError;
  static String? get currentLibraryDir {
    final runtime = _currentRuntime;
    if (runtime is LibraryMusicServerRuntime) {
      return runtime._resolvedLibraryDir;
    }
    return null;
  }
}
