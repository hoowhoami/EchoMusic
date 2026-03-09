import 'music_server_runtime.dart';

const String _musicRuntimeModeDefineKey = 'MUSIC_SERVER_RUNTIME_MODE';

String readStartupMusicRuntimeModeDefine() {
  return const String.fromEnvironment(_musicRuntimeModeDefineKey);
}

MusicServerRuntimeMode resolveStartupMusicRuntimeMode({String? rawMode}) {
  final normalized = (rawMode ?? readStartupMusicRuntimeModeDefine())
      .trim()
      .toLowerCase();

  switch (normalized) {
    case '':
    case 'http':
      return MusicServerRuntimeMode.http;
    case 'library':
      return MusicServerRuntimeMode.library;
    default:
      return MusicServerRuntimeMode.http;
  }
}
