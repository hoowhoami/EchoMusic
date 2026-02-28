import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import 'package:bitsdojo_window/bitsdojo_window.dart';
import 'dart:io';
import '../widgets/sidebar.dart';
import '../widgets/player_bar.dart';
import 'recommend_view.dart';
import 'discover_view.dart';
import 'search_view.dart';
import 'setting_view.dart';
import 'history_view.dart';
import 'cloud_view.dart';
import 'profile_view.dart';
import 'playlist_detail_view.dart';
import 'album_detail_view.dart';
import 'artist_detail_view.dart';
import 'recommend_song_view.dart';
import 'rank_view.dart';
import 'song_detail_view.dart';
import 'song_comment_view.dart';
import '../../models/playlist.dart';
import '../../models/song.dart';
import 'package:echomusic/providers/user_provider.dart';
import 'package:echomusic/providers/persistence_provider.dart';
import 'package:echomusic/providers/selection_provider.dart';
import 'package:echomusic/providers/refresh_provider.dart';
import 'package:echomusic/providers/navigation_provider.dart';
import 'package:package_info_plus/package_info_plus.dart';
import '../../api/music_api.dart';
import '../../utils/version_service.dart';
import '../widgets/user_agreement_dialog.dart';
import '../widgets/update_dialog.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HistoryEntry {
  final int index;
  final String? routeName;
  final dynamic arguments;
  _HistoryEntry({required this.index, this.routeName, this.arguments});
}

class _HomeScreenState extends State<HomeScreen> {
  int _selectedIndex = 0;
  final ValueNotifier<int> _indexNotifier = ValueNotifier(0);
  Playlist? _selectedPlaylist;
  
  List<_HistoryEntry> _history = [_HistoryEntry(index: 0)];
  int _historyIndex = 0;
  bool _isInternalNav = false;

  @override
  void initState() {
    super.initState();
    _initDevice();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _checkInitialState();
    });
  }

  void _checkInitialState() {
    final persistence = context.read<PersistenceProvider>();
    if (!(persistence.settings['userAgreementAccepted'] ?? false)) {
      showDialog(
        context: context,
        barrierDismissible: false,
        builder: (context) => const UserAgreementDialog(),
      );
    } else {
      _checkForUpdates(silent: true);
    }
  }

  Future<void> _checkForUpdates({bool silent = false}) async {
    final updateInfo = await VersionService.checkForUpdates();
    
    if (updateInfo != null && updateInfo.hasUpdate && mounted) {
      showDialog(
        context: context,
        builder: (context) => UpdateDialog(
          version: updateInfo.version,
          releaseNotes: updateInfo.releaseNotes,
        ),
      );
    } else if (!silent && mounted) {
      final packageInfo = await PackageInfo.fromPlatform();
      showDialog(
        context: context,
        builder: (context) => UpdateDialog(
          version: packageInfo.version,
          isLatest: true,
        ),
      );
    }
  }

  @override
  void dispose() {
    _indexNotifier.dispose();
    super.dispose();
  }

  void _navigateTo(int index) {
    if (_selectedIndex == index && _selectedPlaylist == null) return;

    context.read<SelectionProvider>().reset();

    setState(() {
      if (_historyIndex < _history.length - 1) {
        _history.removeRange(_historyIndex + 1, _history.length);
      }
      
      _history.add(_HistoryEntry(index: index));
      _historyIndex = _history.length - 1;
      
      _selectedIndex = index;
      _indexNotifier.value = index;
      _selectedPlaylist = null;
      
      _isInternalNav = true;
      context.read<NavigationProvider>().popUntilFirst();
      _isInternalNav = false;
    });
  }

  void _pushRoute(Widget page, {String? name, dynamic arguments}) {
    context.read<SelectionProvider>().reset();
    context.read<NavigationProvider>().push(page, name: name, arguments: arguments);
  }

  void _goBack() {
    if (_historyIndex > 0) {
      _historyIndex--;
      _syncHistoryState();
    }
  }

  void _goForward() {
    if (_historyIndex < _history.length - 1) {
      _historyIndex++;
      _syncHistoryState();
    }
  }

  void _syncHistoryState() {
    final state = _history[_historyIndex];
    context.read<SelectionProvider>().reset();
    
    _isInternalNav = true;
    setState(() {
      _selectedIndex = state.index;
      _indexNotifier.value = state.index;
      if (state.routeName == 'playlist_detail') {
        _selectedPlaylist = state.arguments as Playlist?;
      } else if (state.routeName == 'album_detail' && state.arguments is Map) {
        _selectedPlaylist = (state.arguments as Map)['playlist'] as Playlist?;
      } else {
        _selectedPlaylist = null;
      }
    });

    context.read<NavigationProvider>().popUntilFirst();
    
    if (state.routeName != null) {
      context.read<NavigationProvider>().push(
        _rebuildPage(state.routeName!, state.arguments),
        name: state.routeName,
        arguments: state.arguments,
      );
    }
    _isInternalNav = false;
  }

  Widget _rebuildPage(String name, dynamic arguments) {
    switch (name) {
      case 'playlist_detail':
        return PlaylistDetailView(playlist: arguments as Playlist);
      case 'album_detail':
        return AlbumDetailView(
          albumId: arguments['id'],
          albumName: arguments['name'],
        );
      case 'recommend_song':
        return RecommendSongView();
      case 'rank_view':
        return RankView(
          isRecommend: arguments?['isRecommend'] ?? false,
          showTitle: arguments?['showTitle'] ?? true,
          initialRankId: arguments?['initialRankId'],
        );
      case 'song_detail':
        return SongDetailView(song: arguments as Song);
      case 'song_comment':
        return SongCommentView(song: arguments as Song);
      case 'artist_detail':
        return ArtistDetailView(
          artistId: arguments['id'],
          artistName: arguments['name'],
        );
      default:
        return const SizedBox();
    }
  }

  bool get canGoBack => _historyIndex > 0;
  bool get canGoForward => _historyIndex < _history.length - 1;


  Future<void> _initDevice() async {
    final persistence = context.read<PersistenceProvider>();
    if (persistence.device == null || persistence.device?['dfid'] == null) {
      final device = await MusicApi.registerDevice();
      if (device != null && device['dfid'] != null) await persistence.setDevice(device);
    }
    final userProvider = context.read<UserProvider>();
    if (userProvider.isAuthenticated) userProvider.fetchAllUserData();
  }

  final List<Widget> _views = [
    const RecommendView(),
    const DiscoverView(),
    const SearchView(),
    const HistoryView(),
    const CloudView(),
    const SettingView(),
    const ProfileView(),
  ];

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final navProvider = context.watch<NavigationProvider>();

    return Scaffold(
      backgroundColor: theme.scaffoldBackgroundColor,
      body: Column(
        children: [
          Expanded(
            child: Row(
              children: [
                Container(
                  width: 260,
                  decoration: BoxDecoration(
                    color: theme.colorScheme.surface,
                    border: Border(right: BorderSide(color: theme.dividerColor.withAlpha(40), width: 0.5)),
                  ),
                  child: Column(
                    children: [
                      SizedBox(height: 48, child: MoveWindow()),
                      Expanded(
                        child: Sidebar(
                          selectedIndex: _selectedIndex,
                          selectedPlaylistId: _selectedPlaylist?.id,
                          onDestinationSelected: _navigateTo,
                          onPushPlaylist: (playlist) {
                             if (playlist.source == 2) {
                               _pushRoute(
                                 AlbumDetailView(
                                   albumId: playlist.originalId, 
                                   albumName: playlist.name,
                                 ),
                                 name: 'album_detail',
                                 arguments: {
                                   'id': playlist.originalId, 
                                   'name': playlist.name,
                                   'playlist': playlist,
                                 }
                               );
                             } else {
                               _pushRoute(
                                 PlaylistDetailView(playlist: playlist), 
                                 name: 'playlist_detail', 
                                 arguments: playlist
                               );
                             }
                          },
                        ),
                      ),
                    ],
                  ),
                ),
                Expanded(
                  child: Column(
                    children: [
                      Container(
                        height: 48,
                        decoration: BoxDecoration(
                          color: theme.scaffoldBackgroundColor,
                          border: Border(bottom: BorderSide(color: theme.dividerColor.withAlpha(30), width: 0.5)),
                        ),
                        child: Row(
                          children: [
                            const SizedBox(width: 12),
                            _buildNavButton(icon: CupertinoIcons.chevron_left, onPressed: canGoBack ? _goBack : null, tooltip: '后退'),
                            const SizedBox(width: 8),
                            _buildNavButton(icon: CupertinoIcons.chevron_right, onPressed: canGoForward ? _goForward : null, tooltip: '前进'),
                            const SizedBox(width: 8),
                            _buildNavButton(
                              icon: CupertinoIcons.refresh, 
                              onPressed: () => context.read<RefreshProvider>().triggerRefresh(), 
                              tooltip: '刷新'
                            ),
                            Expanded(child: MoveWindow()),
                            if (!Platform.isMacOS) const WindowButtons(),
                          ],
                        ),
                      ),
                      Expanded(
                        child: Navigator(
                          key: navProvider.navigatorKey,
                          observers: [
                            _NavigationObserver((route, prevRoute, type) {
                              if (_isInternalNav) return;
                              
                              if (type == _NavChangeType.pop) {
                                WidgetsBinding.instance.addPostFrameCallback((_) {
                                  if (mounted) {
                                    setState(() {
                                      if (prevRoute?.settings.name == 'playlist_detail') {
                                        _selectedPlaylist = prevRoute?.settings.arguments as Playlist?;
                                      } else if (prevRoute?.settings.name == 'album_detail' && prevRoute?.settings.arguments is Map) {
                                        _selectedPlaylist = (prevRoute?.settings.arguments as Map)['playlist'] as Playlist?;
                                      } else {
                                        _selectedPlaylist = null;
                                      }
                                      
                                      if (_historyIndex > 0) {
                                        _historyIndex--;
                                      }
                                    });
                                  }
                                });
                              } else if (type == _NavChangeType.push && route?.settings.name != 'root') {
                                final name = route?.settings.name;
                                final args = route?.settings.arguments;
                                WidgetsBinding.instance.addPostFrameCallback((_) {
                                  if (mounted) {
                                    setState(() {
                                      if (_historyIndex < _history.length - 1) {
                                        _history.removeRange(_historyIndex + 1, _history.length);
                                      }
                                      _history.add(_HistoryEntry(index: _selectedIndex, routeName: name, arguments: args));
                                      _historyIndex = _history.length - 1;
                                      
                                      if (name == 'playlist_detail') {
                                        _selectedPlaylist = args as Playlist?;
                                      } else if (name == 'album_detail' && args is Map) {
                                        _selectedPlaylist = args['playlist'] as Playlist?;
                                      }
                                    });
                                  }
                                });
                              }
                            })
                          ],
                          onGenerateRoute: (settings) => PageRouteBuilder(
                            settings: const RouteSettings(name: 'root'),
                            pageBuilder: (context, _, __) => ValueListenableBuilder<int>(
                              valueListenable: _indexNotifier,
                              builder: (context, index, _) => IndexedStack(
                                index: index, 
                                children: _views
                              ),
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          const PlayerBar(),
        ],
      ),
    );
  }

  Widget _buildNavButton({required IconData icon, required VoidCallback? onPressed, required String tooltip}) {
    final theme = Theme.of(context);
    return Tooltip(
      message: tooltip,
      child: IconButton(
        icon: Icon(icon, size: 18, color: onPressed != null ? theme.colorScheme.onSurface : theme.colorScheme.onSurface.withAlpha(60)),
        onPressed: onPressed,
        padding: EdgeInsets.zero,
        constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
      ),
    );
  }
}

enum _NavChangeType { push, pop }

class _NavigationObserver extends NavigatorObserver {
  final Function(Route?, Route?, _NavChangeType) onStateChanged;
  _NavigationObserver(this.onStateChanged);
  @override
  void didPush(Route route, Route? prev) => onStateChanged(route, prev, _NavChangeType.push);
  @override
  void didPop(Route route, Route? prev) => onStateChanged(route, prev, _NavChangeType.pop);
}

class WindowButtons extends StatelessWidget {
  const WindowButtons({super.key});
  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final buttonColors = WindowButtonColors(iconNormal: theme.colorScheme.onSurfaceVariant, mouseOver: theme.colorScheme.onSurface.withAlpha(25), mouseDown: theme.colorScheme.onSurface.withAlpha(50), iconMouseOver: theme.colorScheme.onSurface, iconMouseDown: theme.colorScheme.onSurface);
    return Row(children: [MinimizeWindowButton(colors: buttonColors), MaximizeWindowButton(colors: buttonColors), CloseWindowButton(colors: WindowButtonColors(mouseOver: const Color(0xFFD32F2F), mouseDown: const Color(0xFFB71C1C), iconNormal: theme.colorScheme.onSurfaceVariant, iconMouseOver: Colors.white))]);
  }
}
