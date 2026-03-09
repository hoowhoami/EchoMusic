import 'music_api_backend.dart';

abstract class LibraryMusicApiBridge {
  Future<void> setCookie(String cookie);

  Future<void> dispose() async {}
}

class NoopLibraryMusicApiBridge implements LibraryMusicApiBridge {
  @override
  Future<void> setCookie(String cookie) async {}

  @override
  Future<void> dispose() async {}
}

class LibraryMusicApiBackend extends MusicApiBackend {
  LibraryMusicApiBackend({LibraryMusicApiBridge? bridge})
    : _bridge = bridge ?? NoopLibraryMusicApiBridge();

  final LibraryMusicApiBridge _bridge;

  @override
  Future<void> syncAuthCookie(String? cookie) async {
    await _bridge.setCookie(cookie ?? '');
  }

  @override
  Future<void> dispose() async {
    await _bridge.dispose();
  }
}
