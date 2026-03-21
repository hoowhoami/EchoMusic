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

  test('handlePlaylistDeletion pops when current view matches deleted ID', () async {
    final navigation = NavigationProvider();
    addTearDown(navigation.dispose);

    navigation.navigateToRoot(4);

    navigation.observer.didPush(
      MaterialPageRoute<void>(
        builder: (_) => const SizedBox.shrink(),
        settings: RouteSettings(
          name: 'playlist_detail',
          arguments: PlaylistDetailRouteArgs(
            playlist: Playlist(
              id: 42,
              name: 'Owned Playlist',
              pic: '',
              intro: '',
              playCount: 0,
            ),
          ),
        ),
      ),
      null,
    );

    expect(navigation.currentRootIndex, 4);
    expect(navigation.currentRouteName, 'playlist_detail');
    expect(navigation.canGoBack, isTrue);

    // Should pop because 42 matches current view
    await navigation.handlePlaylistDeletion(42);

    expect(navigation.currentRootIndex, 4);
    expect(navigation.currentRouteName, isNull);
    expect(navigation.selectedSidebarPlaylistId, isNull);
    expect(navigation.canGoBack, isTrue); // Can still go back to previous root
  });

  test('handlePlaylistDeletion does nothing when current view does not match', () async {
    final navigation = NavigationProvider();
    addTearDown(navigation.dispose);

    navigation.navigateToRoot(4);

    navigation.observer.didPush(
      MaterialPageRoute<void>(
        builder: (_) => const SizedBox.shrink(),
        settings: RouteSettings(
          name: 'playlist_detail',
          arguments: PlaylistDetailRouteArgs(
            playlist: Playlist(
              id: 42,
              name: 'Other Playlist',
              pic: '',
              intro: '',
              playCount: 0,
            ),
          ),
        ),
      ),
      null,
    );

    expect(navigation.currentRouteName, 'playlist_detail');
    expect(navigation.selectedSidebarPlaylistId, 42);

    // Should NOT pop because 99 does not match current view
    await navigation.handlePlaylistDeletion(99);

    expect(navigation.currentRouteName, 'playlist_detail');
    expect(navigation.selectedSidebarPlaylistId, 42);
    expect(navigation.canGoBack, isTrue);
  });
}
