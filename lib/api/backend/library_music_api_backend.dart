import '../../utils/music_server_runtime.dart';
import '../transport/library_music_transport.dart';
import 'http_music_api_backend.dart';
import 'library/kugou_bridge.dart';

class LibraryMusicApiBackend extends HttpMusicApiBackend {
  factory LibraryMusicApiBackend({
    LibraryMusicBridge? bridge,
    String? libraryDir,
    LibraryTransportAuthExpirationHandler? authExpirationHandler,
    LibraryTransportDataFormatter? dataFormatter,
    Future<void> Function()? readyEnsurer,
  }) {
    LibraryMusicBridge? cachedBridge = bridge;
    late final LibraryMusicApiBackend backend;

    LibraryMusicBridge getBridge() {
      final existingBridge = cachedBridge;
      if (existingBridge != null) {
        return existingBridge;
      }

      final createdBridge = IsolatedKugouMusicApiBridge(
        libraryDir:
            libraryDir ?? MusicServerRuntimeController.currentLibraryDir,
      );
      if (backend._cookie.isNotEmpty) {
        createdBridge.setCookie(backend._cookie);
      }
      cachedBridge = createdBridge;
      return createdBridge;
    }

    final transport = LibraryMusicTransport(
      bridgeProvider: getBridge,
      authExpirationHandler: authExpirationHandler,
      dataFormatter: dataFormatter,
      readyEnsurer: readyEnsurer,
    );
    backend = LibraryMusicApiBackend._(
      transport: transport,
      currentBridge: () => cachedBridge,
      disposeBridge: () async {
        await cachedBridge?.dispose();
        cachedBridge = null;
      },
    );
    return backend;
  }

  LibraryMusicApiBackend._({
    required LibraryMusicTransport transport,
    required LibraryMusicBridge? Function() currentBridge,
    required Future<void> Function() disposeBridge,
  }) : _currentBridge = currentBridge,
       _disposeBridge = disposeBridge,
       super(transportProvider: () => transport);

  final LibraryMusicBridge? Function() _currentBridge;
  final Future<void> Function() _disposeBridge;
  Map<String, String> _cookie = const <String, String>{};

  static Map<String, String> parseCookieString(String? cookie) {
    if (cookie == null || cookie.isEmpty) {
      return const <String, String>{};
    }

    final cookieMap = <String, String>{};
    final pairs = cookie.split(';');
    for (final pair in pairs) {
      final trimmed = pair.trim();
      if (trimmed.isEmpty) continue;

      final idx = trimmed.indexOf('=');
      if (idx <= 0) continue;

      final key = trimmed.substring(0, idx).trim();
      final value = trimmed.substring(idx + 1).trim();
      cookieMap[key] = value;
    }

    return cookieMap;
  }

  @override
  Future<void> syncAuthCookie(String? cookie) async {
    _cookie = parseCookieString(cookie);
    final bridge = _currentBridge();
    if (bridge != null) {
      await bridge.setCookie(_cookie);
    }
  }

  @override
  Future<void> dispose() async {
    await _disposeBridge();
  }
}
