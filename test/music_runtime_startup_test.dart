import 'package:echomusic/utils/music_runtime_startup.dart';
import 'package:echomusic/utils/music_server_runtime.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('resolveStartupMusicRuntimeMode defaults to http', () {
    expect(
      resolveStartupMusicRuntimeMode(rawMode: null),
      MusicServerRuntimeMode.http,
    );
    expect(
      resolveStartupMusicRuntimeMode(rawMode: ''),
      MusicServerRuntimeMode.http,
    );
  });

  test('resolveStartupMusicRuntimeMode parses supported values', () {
    expect(
      resolveStartupMusicRuntimeMode(rawMode: 'http'),
      MusicServerRuntimeMode.http,
    );
    expect(
      resolveStartupMusicRuntimeMode(rawMode: 'library'),
      MusicServerRuntimeMode.library,
    );
    expect(
      resolveStartupMusicRuntimeMode(rawMode: '  LiBrArY  '),
      MusicServerRuntimeMode.library,
    );
  });

  test(
    'resolveStartupMusicRuntimeMode falls back to http on invalid value',
    () {
      expect(
        resolveStartupMusicRuntimeMode(rawMode: 'invalid'),
        MusicServerRuntimeMode.http,
      );
    },
  );
}
