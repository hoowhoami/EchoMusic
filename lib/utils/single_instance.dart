import 'dart:async';
import 'dart:io';

/// Single instance enforcement via Unix domain socket (macOS/Linux/Windows 10+).
///
/// MUST call [acquire] BEFORE WidgetsFlutterBinding.ensureInitialized() so the
/// secondary instance exits with zero native-UI initialization — preventing
/// ghost menu-bar / tray icons on macOS.
class SingleInstance {
  SingleInstance._();

  static ServerSocket? _server;
  static StreamSubscription<Socket>? _sub;

  static String get _socketPath {
    if (Platform.isWindows) {
      final tmp = Platform.environment['TEMP'] ??
          Platform.environment['TMP'] ??
          r'C:\Windows\Temp';
      return '$tmp\\echomusic.sock';
    }
    // macOS: $TMPDIR is a per-user sandbox temp dir (e.g. /var/folders/…/T/)
    // Linux:  prefer $XDG_RUNTIME_DIR (per-user), fall back to /tmp
    final dir = Platform.environment['TMPDIR'] ??
        Platform.environment['XDG_RUNTIME_DIR'] ??
        '/tmp';
    return '$dir/echomusic.sock';
  }

  /// Try to acquire the single-instance lock.
  ///
  /// Returns `true` if this is the **primary** instance.
  /// Returns `false` if another instance is already running; a focus request
  /// is automatically sent to that instance before returning.
  static Future<bool> acquire() async {
    return _tryBind();
  }

  static Future<bool> _tryBind({bool afterCleanup = false}) async {
    try {
      _server = await ServerSocket.bind(
        InternetAddress(_socketPath, type: InternetAddressType.unix),
        0,
      );
      return true; // primary instance
    } on SocketException {
      if (afterCleanup) return true; // give up, let the app start

      // Socket file exists — check if a live instance owns it.
      try {
        final sock = await Socket.connect(
          InternetAddress(_socketPath, type: InternetAddressType.unix),
          0,
          timeout: const Duration(seconds: 2),
        );
        sock.write('focus');
        await sock.flush();
        await sock.close();
        return false; // live primary instance found
      } catch (_) {
        // Stale socket (previous crash) — delete and retry once.
        try {
          await File(_socketPath).delete();
        } catch (_) {}
        return _tryBind(afterCleanup: true);
      }
    }
  }

  /// Start listening for focus requests from secondary instances.
  ///
  /// Call this after the window / tray is ready so focus-raising works correctly.
  static void listenForFocus(void Function() onFocus) {
    _sub = _server?.listen((socket) {
      socket.listen(
        (_) {
          onFocus();
          socket.destroy();
        },
        onError: (_) => socket.destroy(),
        cancelOnError: true,
      );
    });
  }

  /// Release the lock. Call on clean app exit.
  static Future<void> release() async {
    await _sub?.cancel();
    await _server?.close();
    _server = null;
    _sub = null;
    try {
      await File(_socketPath).delete();
    } catch (_) {}
  }
}
