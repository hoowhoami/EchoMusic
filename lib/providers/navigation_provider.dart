import 'package:flutter/cupertino.dart';

import '../models/playlist.dart';
import '../models/song.dart';
import '../ui/screens/album_detail_view.dart';
import '../ui/screens/artist_detail_view.dart';
import '../ui/screens/playlist_detail_view.dart';
import '../ui/screens/rank_view.dart';
import '../ui/screens/recommend_song_view.dart';
import '../ui/screens/song_detail_comment_view.dart';

class NavigationProvider extends ChangeNotifier {
  NavigationProvider();

  final GlobalKey<NavigatorState> _contentNavigatorKey =
      GlobalKey<NavigatorState>();
  late final NavigatorObserver _observer = _NavigationStateObserver(this);

  final List<_ContentHistorySnapshot> _history = [
    const _ContentHistorySnapshot(rootIndex: 0, details: []),
  ];
  final List<_ContentRouteEntry> _detailStack = [];

  int _historyIndex = 0;
  int _currentRootIndex = 0;
  int _rootActivationVersion = 0;
  bool _suppressHistory = false;
  String? _currentRouteName;
  dynamic _currentRouteArguments;

  GlobalKey<NavigatorState> get navigatorKey => _contentNavigatorKey;
  NavigatorObserver get observer => _observer;
  String? get currentRouteName => _currentRouteName;
  dynamic get currentRouteArguments => _currentRouteArguments;
  int get currentRootIndex => _currentRootIndex;
  int get rootActivationVersion => _rootActivationVersion;
  bool get canGoBack => _historyIndex > 0;
  bool get canGoForward => _historyIndex < _history.length - 1;
  String get currentRefreshKey => _detailStack.isNotEmpty
      ? _routeRefreshKey(_detailStack.last.name, _detailStack.last.arguments)
      : _rootRefreshKey(_currentRootIndex);

  dynamic get selectedSidebarPlaylistId {
    if (_currentRouteName == 'playlist_detail') {
      if (_currentRouteArguments is PlaylistDetailRouteArgs) {
        return (_currentRouteArguments as PlaylistDetailRouteArgs).playlistId;
      }
      if (_currentRouteArguments is Playlist) {
        return (_currentRouteArguments as Playlist).id;
      }
    }
    if (_currentRouteName == 'album_detail' && _currentRouteArguments is Map) {
      return (_currentRouteArguments as Map)['playlist'] is Playlist
          ? ((_currentRouteArguments as Map)['playlist'] as Playlist).id
          : null;
    }
    return null;
  }

  void navigateToRoot(int index) {
    if (_currentRootIndex == index && _detailStack.isEmpty) return;
    final previousRootIndex = _currentRootIndex;
    final hadDetails = _detailStack.isNotEmpty;
    _suppressHistory = true;
    popUntilFirst();
    _detailStack.clear();
    _currentRootIndex = index;
    if (previousRootIndex != index || hadDetails) {
      _rootActivationVersion++;
    }
    _updateCurrentRouteFromStack(notify: false);
    _suppressHistory = false;
    _recordPushSnapshot();
  }

  void openPlaylist(Playlist playlist) {
    final routeArgs = PlaylistDetailRouteArgs.fromPlaylist(playlist);
    push(
      PlaylistDetailView(routeArgs: routeArgs),
      name: 'playlist_detail',
      arguments: routeArgs,
    );
  }

  void openAlbum(int albumId, String albumName, {Playlist? playlist}) {
    final arguments = <String, dynamic>{'id': albumId, 'name': albumName};
    if (playlist != null) {
      arguments['playlist'] = playlist;
    }
    push(
      AlbumDetailView(albumId: albumId, albumName: albumName),
      name: 'album_detail',
      arguments: arguments,
    );
  }

  void openArtist(int artistId, String artistName) {
    push(
      ArtistDetailView(artistId: artistId, artistName: artistName),
      name: 'artist_detail',
      arguments: {'id': artistId, 'name': artistName},
    );
  }

  void openRecommendSong() {
    push(const RecommendSongView(), name: 'recommend_song');
  }

  void openRank({
    bool isRecommend = false,
    bool showTitle = true,
    int? initialRankId,
  }) {
    final arguments = {
      'isRecommend': isRecommend,
      'showTitle': showTitle,
      'initialRankId': initialRankId,
    };
    push(
      RankView(
        isRecommend: isRecommend,
        showTitle: showTitle,
        initialRankId: initialRankId,
      ),
      name: 'rank_view',
      arguments: arguments,
    );
  }

  void openSongDetail(Song song) {
    push(
      SongDetailCommentView(song: song),
      name: 'song_detail',
      arguments: song,
    );
  }

  void openSongComment(Song song) {
    push(
      SongDetailCommentView(song: song),
      name: 'song_comment',
      arguments: song,
    );
  }

  void push(Widget page, {String? name, dynamic arguments}) {
    _contentNavigatorKey.currentState?.push(
      CupertinoPageRoute(
        builder: (_) => page,
        settings: RouteSettings(name: name, arguments: arguments),
      ),
    );
  }

  void pop() {
    _contentNavigatorKey.currentState?.pop();
  }

  void popUntilFirst() {
    _contentNavigatorKey.currentState?.popUntil((route) => route.isFirst);
  }

  Future<void> goBack() async {
    if (!canGoBack) return;
    _historyIndex--;
    await _restoreSnapshot(_history[_historyIndex]);
  }

  Future<void> goForward() async {
    if (!canGoForward) return;
    _historyIndex++;
    await _restoreSnapshot(_history[_historyIndex]);
  }

  bool isCurrentRoute(String routeName, {int? id}) {
    if (_currentRouteName != routeName) return false;
    if (id == null) return true;

    final args = _currentRouteArguments;
    if (args is! Map) return false;

    final dynamic rawId = args['id'];
    if (rawId is int) return rawId == id;
    return int.tryParse('$rawId') == id;
  }

  void resetToRootAfterPlaylistDeletion() {
    final hadDetails = _detailStack.isNotEmpty;

    _suppressHistory = true;
    popUntilFirst();
    _detailStack.clear();
    if (hadDetails) {
      _rootActivationVersion++;
    }
    _updateCurrentRouteFromStack(notify: false);
    _suppressHistory = false;

    _history
      ..clear()
      ..add(_currentSnapshot());
    _historyIndex = 0;

    notifyListeners();
  }

  Future<void> _restoreSnapshot(_ContentHistorySnapshot snapshot) async {
    final previousRootIndex = _currentRootIndex;
    final hadDetails = _detailStack.isNotEmpty;
    _suppressHistory = true;
    popUntilFirst();
    _detailStack.clear();
    _currentRootIndex = snapshot.rootIndex;
    if (snapshot.details.isEmpty &&
        (previousRootIndex != snapshot.rootIndex || hadDetails)) {
      _rootActivationVersion++;
    }
    _updateCurrentRouteFromStack(notify: true);

    await Future<void>.delayed(Duration.zero);

    for (final entry in snapshot.details) {
      push(
        _buildPage(entry.name, entry.arguments),
        name: entry.name,
        arguments: entry.arguments,
      );
    }

    await Future<void>.delayed(Duration.zero);
    _suppressHistory = false;
    _updateCurrentRouteFromStack(notify: false);
    notifyListeners();
  }

  Widget _buildPage(String name, dynamic arguments) {
    switch (name) {
      case 'playlist_detail':
        if (arguments is PlaylistDetailRouteArgs) {
          return PlaylistDetailView(routeArgs: arguments);
        }
        return PlaylistDetailView(
          routeArgs: PlaylistDetailRouteArgs.fromPlaylist(
            arguments as Playlist,
          ),
        );
      case 'album_detail':
        final args = arguments as Map;
        return AlbumDetailView(
          albumId: _parseId(args['id']),
          albumName: (args['name'] ?? '').toString(),
        );
      case 'recommend_song':
        return const RecommendSongView();
      case 'rank_view':
        final args = arguments as Map?;
        return RankView(
          isRecommend: args?['isRecommend'] ?? false,
          showTitle: args?['showTitle'] ?? true,
          initialRankId: args?['initialRankId'],
        );
      case 'song_detail':
        return SongDetailCommentView(song: arguments as Song);
      case 'song_comment':
        return SongDetailCommentView(song: arguments as Song);
      case 'artist_detail':
        final args = arguments as Map;
        return ArtistDetailView(
          artistId: _parseId(args['id']),
          artistName: (args['name'] ?? '').toString(),
        );
      default:
        return const SizedBox.shrink();
    }
  }

  int _parseId(dynamic value) {
    if (value is int) return value;
    return int.tryParse('$value') ?? 0;
  }

  void _handleDidPush(Route<dynamic> route) {
    final entry = _entryFromRoute(route);
    if (entry != null) {
      _detailStack.add(entry);
    }
    _updateCurrentRouteFromStack(notify: false);
    if (!_suppressHistory) {
      _recordPushSnapshot();
    }
  }

  void _handleDidPop(Route<dynamic> route, Route<dynamic>? previousRoute) {
    final poppedEntry = _entryFromRoute(route);
    if (poppedEntry != null && _detailStack.isNotEmpty) {
      _removeLastMatchingEntry(poppedEntry);
    }
    _updateCurrentRouteFromStack(notify: false);
    if (!_suppressHistory) {
      _recordPopSnapshot();
    }
  }

  void _handleDidReplace({Route<dynamic>? newRoute, Route<dynamic>? oldRoute}) {
    final oldEntry = oldRoute == null ? null : _entryFromRoute(oldRoute);
    final newEntry = newRoute == null ? null : _entryFromRoute(newRoute);

    if (oldEntry != null) {
      _removeLastMatchingEntry(oldEntry);
    }
    if (newEntry != null) {
      _detailStack.add(newEntry);
    }

    _updateCurrentRouteFromStack(notify: false);
    if (!_suppressHistory) {
      _recordPushSnapshot();
    }
  }

  void _handleDidRemove(Route<dynamic> route, Route<dynamic>? previousRoute) {
    final removedEntry = _entryFromRoute(route);
    if (removedEntry != null) {
      _removeLastMatchingEntry(removedEntry);
    }
    _updateCurrentRouteFromStack(notify: false);
    if (!_suppressHistory) {
      _recordPopSnapshot();
    }
  }

  _ContentRouteEntry? _entryFromRoute(Route<dynamic> route) {
    final name = route.settings.name;
    if (name == null || name == 'root') return null;
    return _ContentRouteEntry(name: name, arguments: route.settings.arguments);
  }

  void _removeLastMatchingEntry(_ContentRouteEntry entry) {
    for (int index = _detailStack.length - 1; index >= 0; index--) {
      if (_detailStack[index].isSameRoute(entry)) {
        _detailStack.removeAt(index);
        return;
      }
    }
  }

  void _recordPushSnapshot() {
    final snapshot = _currentSnapshot();
    if (_historyIndex < _history.length - 1) {
      _history.removeRange(_historyIndex + 1, _history.length);
    }
    if (_history[_historyIndex].equals(snapshot)) {
      // The nested Navigator pushes its initial root route while the widget
      // tree is still building. That push does not change our navigation
      // snapshot, so notifying listeners here is both unnecessary and can
      // trigger "setState() or markNeedsBuild() called during build".
      return;
    }
    _history.add(snapshot);
    _historyIndex = _history.length - 1;
    notifyListeners();
  }

  void _recordPopSnapshot() {
    final snapshot = _currentSnapshot();
    if (_historyIndex > 0 && _history[_historyIndex - 1].equals(snapshot)) {
      _historyIndex--;
      notifyListeners();
      return;
    }
    if (_historyIndex < _history.length - 1) {
      _history.removeRange(_historyIndex + 1, _history.length);
    }
    if (!_history[_historyIndex].equals(snapshot)) {
      _history.add(snapshot);
      _historyIndex = _history.length - 1;
    }
    notifyListeners();
  }

  _ContentHistorySnapshot _currentSnapshot() {
    return _ContentHistorySnapshot(
      rootIndex: _currentRootIndex,
      details: _detailStack
          .map((entry) => entry.copy())
          .toList(growable: false),
    );
  }

  void _updateCurrentRouteFromStack({required bool notify}) {
    final entry = _detailStack.isNotEmpty ? _detailStack.last : null;
    final changed =
        _currentRouteName != entry?.name ||
        !identical(_currentRouteArguments, entry?.arguments);
    _currentRouteName = entry?.name;
    _currentRouteArguments = entry?.arguments;

    if (notify && changed) {
      notifyListeners();
    }
  }

  String _routeRefreshKey(String name, dynamic arguments) {
    switch (name) {
      case 'playlist_detail':
        final id = arguments is PlaylistDetailRouteArgs
            ? arguments.lookupId
            : ((arguments as Playlist).globalCollectionId ??
                  arguments.id.toString());
        return 'playlist:$id';
      case 'album_detail':
      case 'artist_detail':
        if (arguments is Map) {
          return '$name:${_parseId(arguments['id'])}';
        }
        return name;
      case 'song_detail':
      case 'song_comment':
        final song = arguments as Song;
        final songKey = song.mixSongId != 0
            ? song.mixSongId.toString()
            : song.hash;
        return '$name:$songKey';
      case 'rank_view':
        if (arguments is Map) {
          return 'rank:${arguments['initialRankId'] ?? 'default'}:${arguments['isRecommend'] == true}';
        }
        return 'rank:default';
      default:
        return name;
    }
  }

  String _rootRefreshKey(int index) => 'root:$index';
}

class _NavigationStateObserver extends NavigatorObserver {
  final NavigationProvider provider;

  _NavigationStateObserver(this.provider);

  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) {
    provider._handleDidPush(route);
    super.didPush(route, previousRoute);
  }

  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) {
    provider._handleDidPop(route, previousRoute);
    super.didPop(route, previousRoute);
  }

  @override
  void didReplace({Route<dynamic>? newRoute, Route<dynamic>? oldRoute}) {
    provider._handleDidReplace(newRoute: newRoute, oldRoute: oldRoute);
    super.didReplace(newRoute: newRoute, oldRoute: oldRoute);
  }

  @override
  void didRemove(Route<dynamic> route, Route<dynamic>? previousRoute) {
    provider._handleDidRemove(route, previousRoute);
    super.didRemove(route, previousRoute);
  }
}

class _ContentRouteEntry {
  const _ContentRouteEntry({required this.name, this.arguments});

  final String name;
  final dynamic arguments;

  _ContentRouteEntry copy() =>
      _ContentRouteEntry(name: name, arguments: arguments);

  bool isSameRoute(_ContentRouteEntry other) =>
      name == other.name &&
      _identityKey(name, arguments) ==
          _identityKey(other.name, other.arguments);

  static String _identityKey(String name, dynamic arguments) {
    switch (name) {
      case 'playlist_detail':
        if (arguments is PlaylistDetailRouteArgs) {
          return arguments.lookupId;
        }
        final playlist = arguments as Playlist;
        return playlist.globalCollectionId ?? playlist.id.toString();
      case 'album_detail':
      case 'artist_detail':
        if (arguments is Map) {
          final rawId = arguments['id'];
          return rawId?.toString() ?? '';
        }
        return '';
      case 'song_detail':
      case 'song_comment':
        final song = arguments as Song;
        return song.mixSongId != 0
            ? 'mix:${song.mixSongId}'
            : 'hash:${song.hash}';
      case 'rank_view':
        if (arguments is Map) {
          return '${arguments['initialRankId'] ?? ''}:${arguments['isRecommend'] == true}:${arguments['showTitle'] != false}';
        }
        return '';
      default:
        return arguments?.toString() ?? '';
    }
  }
}

class _ContentHistorySnapshot {
  const _ContentHistorySnapshot({
    required this.rootIndex,
    required this.details,
  });

  final int rootIndex;
  final List<_ContentRouteEntry> details;

  bool equals(_ContentHistorySnapshot other) {
    if (rootIndex != other.rootIndex ||
        details.length != other.details.length) {
      return false;
    }
    for (int index = 0; index < details.length; index++) {
      if (!details[index].isSameRoute(other.details[index])) {
        return false;
      }
    }
    return true;
  }
}
