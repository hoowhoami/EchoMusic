import 'package:echomusic/models/playlist.dart';
import 'package:echomusic/providers/navigation_provider.dart';
import 'package:echomusic/ui/screens/playlist_detail_view.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('navigateToRoot keeps same version on no-op root navigation', () {
    final navigation = NavigationProvider();
    addTearDown(navigation.dispose);

    expect(navigation.rootActivationVersion, 0);

    navigation.navigateToRoot(0);

    expect(navigation.rootActivationVersion, 0);
  });

  test('navigateToRoot bumps version when leaving detail for same root', () {
    final navigation = NavigationProvider();
    addTearDown(navigation.dispose);

    navigation.navigateToRoot(4);
    expect(navigation.rootActivationVersion, 1);

    navigation.observer.didPush(
      MaterialPageRoute<void>(
        builder: (_) => const SizedBox.shrink(),
        settings: RouteSettings(
          name: 'playlist_detail',
          arguments: PlaylistDetailRouteArgs(
            playlist: Playlist(
              id: 42,
              name: 'Test Playlist',
              pic: '',
              intro: '',
              playCount: 0,
            ),
          ),
        ),
      ),
      null,
    );

    navigation.navigateToRoot(4);

    expect(navigation.rootActivationVersion, 2);
    expect(navigation.currentRootIndex, 4);
    expect(navigation.currentRouteName, isNull);
  });
}
