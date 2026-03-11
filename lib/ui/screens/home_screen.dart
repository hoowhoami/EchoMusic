import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import 'package:window_manager/window_manager.dart';
import 'dart:io';
import '../widgets/sidebar.dart';
import '../widgets/player_bar.dart';
import '../widgets/app_shortcuts.dart';
import 'recommend_view.dart';
import 'discover_view.dart';
import 'search_view.dart';
import 'setting_view.dart';
import 'history_view.dart';
import 'cloud_view.dart';
import 'profile_view.dart';
import '../../models/playlist.dart';
import 'package:echomusic/providers/user_provider.dart';
import 'package:echomusic/providers/persistence_provider.dart';
import 'package:echomusic/providers/selection_provider.dart';
import 'package:echomusic/providers/refresh_provider.dart';
import 'package:echomusic/providers/navigation_provider.dart';
import 'package:package_info_plus/package_info_plus.dart';
import '../../api/music_api.dart';
import '../../utils/player_shortcut_actions.dart';
import '../../utils/version_service.dart';
import '../widgets/user_agreement_dialog.dart';
import '../widgets/update_dialog.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {

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
      if (!mounted) return;
      showDialog(
        context: context,
        builder: (context) =>
            UpdateDialog(version: packageInfo.version, isLatest: true),
      );
    }
  }

  void _navigateTo(int index) {
    context.read<SelectionProvider>().reset();
    context.read<NavigationProvider>().navigateToRoot(index);
  }

  void _pushPlaylist(Playlist playlist) {
    context.read<SelectionProvider>().reset();
    final navigation = context.read<NavigationProvider>();
    if (playlist.source == 2) {
      navigation.openAlbum(
        playlist.originalId,
        playlist.name,
        playlist: playlist,
      );
    } else {
      navigation.openPlaylist(playlist);
    }
  }

  Future<void> _goBack() async {
    context.read<SelectionProvider>().reset();
    await context.read<NavigationProvider>().goBack();
  }

  Future<void> _goForward() async {
    context.read<SelectionProvider>().reset();
    await context.read<NavigationProvider>().goForward();
  }

  void _refreshCurrentView() {
    final navProvider = context.read<NavigationProvider>();
    context.read<RefreshProvider>().triggerRefresh(
      navProvider.currentRefreshKey,
    );
  }

  Future<void> _initDevice() async {
    final persistence = context.read<PersistenceProvider>();

    // 1. 确保设备注册完成（获取 dfid, mid 等标识符）
    if (persistence.device == null || persistence.device?['dfid'] == null) {
      final device = await MusicApi.registerDevice();
      if (device != null && device['dfid'] != null) {
        await persistence.setDevice(device);
      }
    }

    // 2. 设备就绪后，再发起用户信息同步
    if (mounted) {
      final userProvider = context.read<UserProvider>();
      if (userProvider.isAuthenticated) {
        userProvider.fetchAllUserData();
      }
    }
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

    return AppShortcuts(
      onTogglePlayback: () => PlayerShortcutActions.togglePlayback(context),
      onPreviousTrack: () => PlayerShortcutActions.previousTrack(context),
      onNextTrack: () => PlayerShortcutActions.nextTrack(context),
      onVolumeUp: () => PlayerShortcutActions.increaseVolume(context),
      onVolumeDown: () => PlayerShortcutActions.decreaseVolume(context),
      onToggleMute: () => PlayerShortcutActions.toggleMute(context),
      onToggleFavorite: () => PlayerShortcutActions.toggleFavorite(context),
      onTogglePlayMode: () => PlayerShortcutActions.togglePlayMode(context),
      child: Scaffold(
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
                      border: Border(
                        right: BorderSide(
                          color: theme.dividerColor.withAlpha(40),
                          width: 0.5,
                        ),
                      ),
                    ),
                    child: Column(
                      children: [
                        const SizedBox(
                          height: 48,
                          width: double.infinity,
                          child: DragToMoveArea(child: SizedBox.expand()),
                        ),
                        Expanded(
                          child: Sidebar(
                            selectedIndex: navProvider.currentRootIndex,
                            selectedPlaylistId:
                                navProvider.selectedSidebarPlaylistId,
                            onDestinationSelected: _navigateTo,
                            onPushPlaylist: _pushPlaylist,
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
                            border: Border(
                              bottom: BorderSide(
                                color: theme.dividerColor.withAlpha(30),
                                width: 0.5,
                              ),
                            ),
                          ),
                          child: Row(
                            children: [
                              const SizedBox(width: 12),
                              _buildNavButton(
                                icon: CupertinoIcons.chevron_left,
                                onPressed: navProvider.canGoBack
                                    ? _goBack
                                    : null,
                                tooltip: '后退',
                              ),
                              const SizedBox(width: 8),
                              _buildNavButton(
                                icon: CupertinoIcons.chevron_right,
                                onPressed: navProvider.canGoForward
                                    ? _goForward
                                    : null,
                                tooltip: '前进',
                              ),
                              const SizedBox(width: 8),
                              _buildNavButton(
                                icon: CupertinoIcons.refresh,
                                onPressed: _refreshCurrentView,
                                tooltip: '刷新',
                              ),
                              const Expanded(
                                child: DragToMoveArea(
                                  child: SizedBox.expand(),
                                ),
                              ),
                              if (!Platform.isMacOS)
                                const Padding(
                                  padding: EdgeInsets.only(right: 8),
                                  child: _WindowControlButtons(),
                                ),
                            ],
                          ),
                        ),
                        Expanded(
                          child: Navigator(
                            key: navProvider.navigatorKey,
                            observers: [navProvider.observer],
                            onGenerateRoute: (settings) => PageRouteBuilder(
                              settings: const RouteSettings(name: 'root'),
                              pageBuilder: (context, _, _) =>
                                  Consumer<NavigationProvider>(
                                    builder: (context, provider, _) =>
                                        _LazyIndexedStack(
                                          index: provider.currentRootIndex,
                                          children: _views,
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
      ),
    );
  }

  Widget _buildNavButton({
    required IconData icon,
    required VoidCallback? onPressed,
    required String tooltip,
  }) {
    final theme = Theme.of(context);
    return Tooltip(
      message: tooltip,
      child: IconButton(
        icon: Icon(
          icon,
          size: 18,
          color: onPressed != null
              ? theme.colorScheme.onSurface
              : theme.colorScheme.onSurface.withAlpha(60),
        ),
        onPressed: onPressed,
        padding: EdgeInsets.zero,
        constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
      ),
    );
  }
}

class _WindowControlButtons extends StatefulWidget {
  const _WindowControlButtons();

  @override
  State<_WindowControlButtons> createState() => _WindowControlButtonsState();
}

class _WindowControlButtonsState extends State<_WindowControlButtons>
    with WindowListener {
  bool _isMaximized = false;

  @override
  void initState() {
    super.initState();
    windowManager.addListener(this);
    _syncWindowState();
  }

  Future<void> _syncWindowState() async {
    final isMaximized = await windowManager.isMaximized();
    if (!mounted) return;
    setState(() => _isMaximized = isMaximized);
  }

  @override
  void dispose() {
    windowManager.removeListener(this);
    super.dispose();
  }

  @override
  void onWindowMaximize() {
    setState(() => _isMaximized = true);
  }

  @override
  void onWindowUnmaximize() {
    setState(() => _isMaximized = false);
  }

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;

    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        WindowCaptionButton.minimize(
          brightness: brightness,
          onPressed: () => windowManager.minimize(),
        ),
        _isMaximized
            ? WindowCaptionButton.unmaximize(
                brightness: brightness,
                onPressed: () => windowManager.unmaximize(),
              )
            : WindowCaptionButton.maximize(
                brightness: brightness,
                onPressed: () => windowManager.maximize(),
              ),
        WindowCaptionButton.close(
          brightness: brightness,
          onPressed: () => windowManager.close(),
        ),
      ],
    );
  }
}

/// IndexedStack that defers building children until their tab is first visited.
class _LazyIndexedStack extends StatefulWidget {
  final int index;
  final List<Widget> children;
  const _LazyIndexedStack({required this.index, required this.children});

  @override
  State<_LazyIndexedStack> createState() => _LazyIndexedStackState();
}

class _LazyIndexedStackState extends State<_LazyIndexedStack> {
  late final List<bool> _activated;

  @override
  void initState() {
    super.initState();
    _activated = List.generate(
      widget.children.length,
      (i) => i == widget.index,
    );
  }

  @override
  void didUpdateWidget(_LazyIndexedStack old) {
    super.didUpdateWidget(old);
    if (!_activated[widget.index]) {
      setState(() => _activated[widget.index] = true);
    }
  }

  @override
  Widget build(BuildContext context) {
    return IndexedStack(
      index: widget.index,
      children: [
        for (int i = 0; i < widget.children.length; i++)
          _activated[i] ? widget.children[i] : const SizedBox.shrink(),
      ],
    );
  }
}
