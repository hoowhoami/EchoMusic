import 'dart:async';
import 'dart:io';

/// Single instance enforcement using a PID lock file + SIGUSR1 (macOS/Linux).
///
/// Advantages over Unix-socket approach:
/// - No persistent file descriptor — survives Flutter hot restarts cleanly.
/// - Hot restart: same PID found in lock file → skip signal, re-register handler.
/// - Second instance: sends SIGUSR1 to the running process, then exits.
/// - Stale lock file (crash): kill() fails → treated as no existing instance.
///
/// MUST call [acquire] BEFORE WidgetsFlutterBinding.ensureInitialized().
class SingleInstance {
  SingleInstance._();

  static void Function()? _onFocus;

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
    // $TMPDIR on macOS may end with '/'; use joinPath-style concatenation.
    return dir.endsWith('/') ? '${dir}echomusic.lock' : '$dir/echomusic.lock';
  }

  /// Try to acquire the single-instance lock.
  ///
  /// Returns `true` if this is the **primary** instance.
  /// Returns `false` if another live instance is running (signal already sent).
  static Future<bool> acquire() async {
    if (Platform.isWindows) return true; // Windows: no-op for now

    final lockFile = File(_lockFilePath);

    if (await lockFile.exists()) {
      try {
        final content = (await lockFile.readAsString()).trim();
        final storedPid = int.tryParse(content);

        if (storedPid != null && storedPid != pid) {
          // Try to signal the stored PID. If it succeeds the process is alive.
          final alive = Process.killPid(storedPid, ProcessSignal.sigusr1);
          if (alive) return false; // another instance received the signal
          // killPid returned false → process is gone, stale lock file
        }
        // storedPid == pid → hot restart within the same OS process, continue.
      } catch (_) {
        // Unreadable lock file — treat as stale.
      }
    }

    // We are (or remain) the primary instance.
    await lockFile.writeAsString(pid.toString());

    // (Re-)register the SIGUSR1 handler each time acquire() is called so that
    // hot restarts re-attach the listener to the new Dart VM.
    ProcessSignal.sigusr1.watch().listen((_) {
      _onFocus?.call();
    });

    return true;
  }

  /// Register a callback invoked when a secondary instance requests focus.
  /// Safe to call multiple times (hot restarts).
  static void listenForFocus(void Function() onFocus) {
    _onFocus = onFocus;
  }

  /// Release the lock on clean exit.
  static Future<void> release() async {
    _onFocus = null;
    try {
      await File(_lockFilePath).delete();
    } catch (_) {}
  }
}
