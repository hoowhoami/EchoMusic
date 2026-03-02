import 'dart:async';
import 'dart:io';

/// Single instance enforcement.
///
/// - macOS / Linux : PID lock file + SIGUSR1 signal.
/// - Windows       : PID lock file + loopback TCP socket (port [_windowsPort]).
///
/// MUST call [acquire] BEFORE WidgetsFlutterBinding.ensureInitialized() so the
/// secondary instance exits before any native plugin is registered.
class SingleInstance {
  SingleInstance._();

  static void Function()? _onFocus;

  // ── Windows TCP ────────────────────────────────────────────────────────────
  static const int _windowsPort = 45782; // fixed IPC port for EchoMusic
  static ServerSocket? _tcpServer;

  // ── Paths ──────────────────────────────────────────────────────────────────
  static String get _lockFilePath {
    if (Platform.isWindows) {
      final tmp = Platform.environment['TEMP'] ??
          Platform.environment['TMP'] ??
          r'C:\Windows\Temp';
      return '$tmp\\echomusic.lock';
    }
    final dir = Platform.environment['TMPDIR'] ??
        Platform.environment['XDG_RUNTIME_DIR'] ??
        '/tmp';
    return dir.endsWith('/') ? '${dir}echomusic.lock' : '$dir/echomusic.lock';
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /// Try to acquire the single-instance lock.
  ///
  /// Returns `true`  → primary instance, app should continue.
  /// Returns `false` → secondary instance, focus signal sent, app should exit.
  static Future<bool> acquire() async {
    if (Platform.isWindows) return _acquireWindows();
    return _acquireUnix();
  }

  /// Register the callback invoked when a secondary instance requests focus.
  static void listenForFocus(void Function() onFocus) {
    _onFocus = onFocus;
  }

  /// Release the lock on clean exit.
  static Future<void> release() async {
    _onFocus = null;
    if (Platform.isWindows) {
      await _tcpServer?.close();
      _tcpServer = null;
    }
    try {
      await File(_lockFilePath).delete();
    } catch (_) {}
  }

  // ── macOS / Linux : lock file + SIGUSR1 ───────────────────────────────────

  static Future<bool> _acquireUnix() async {
    final lockFile = File(_lockFilePath);

    if (await lockFile.exists()) {
      try {
        final storedPid = int.tryParse((await lockFile.readAsString()).trim());
        if (storedPid != null && storedPid != pid) {
          final alive = Process.killPid(storedPid, ProcessSignal.sigusr1);
          if (alive) return false; // live instance signalled
          // killPid returned false → stale lock file, continue
        }
        // storedPid == pid → hot restart in same OS process, continue
      } catch (_) {}
    }

    await lockFile.writeAsString(pid.toString());

    // Re-register on every acquire() so hot restarts re-attach the handler.
    ProcessSignal.sigusr1.watch().listen((_) => _onFocus?.call());

    return true;
  }

  // ── Windows : lock file + loopback TCP ────────────────────────────────────

  static Future<bool> _acquireWindows({bool retrying = false}) async {
    try {
      _tcpServer = await ServerSocket.bind(
        InternetAddress.loopbackIPv4,
        _windowsPort,
      );
      await File(_lockFilePath).writeAsString(pid.toString());
      _listenTcp(_tcpServer!);
      return true;
    } on SocketException {
      if (retrying) return true; // give up after one retry

      // Check if the bound port belongs to our own process (hot restart).
      final lockFile = File(_lockFilePath);
      if (await lockFile.exists()) {
        try {
          final storedPid =
              int.tryParse((await lockFile.readAsString()).trim());
          if (storedPid == pid) {
            // Hot restart: tell the still-running server to release the port.
            await _sendTcp('restart');
            await Future<void>.delayed(const Duration(milliseconds: 150));
            return _acquireWindows(retrying: true);
          }
        } catch (_) {}
      }

      // Different process: signal it to focus, then exit.
      await _sendTcp('focus');
      return false;
    }
  }

  static void _listenTcp(ServerSocket server) {
    server.listen((socket) {
      socket.listen(
        (data) {
          final msg = String.fromCharCodes(data).trim();
          if (msg == 'focus') {
            _onFocus?.call();
          } else if (msg == 'restart') {
            // Hot restart requested — release the port so the new Dart VM
            // can rebind it after the delay in _acquireWindows.
            socket.destroy();
            server.close();
            _tcpServer = null;
          }
          socket.destroy();
        },
        onError: (_) => socket.destroy(),
        cancelOnError: true,
      );
    });
  }

  static Future<void> _sendTcp(String message) async {
    try {
      final socket = await Socket.connect(
        InternetAddress.loopbackIPv4,
        _windowsPort,
        timeout: const Duration(seconds: 2),
      );
      socket.write(message);
      await socket.flush();
      await socket.close();
    } catch (_) {}
  }
}
