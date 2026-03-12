import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import 'package:window_manager/window_manager.dart';
import 'dart:io';
import '../widgets/sidebar.dart';
import '../widgets/player_bar.dart';
import '../widgets/app_shortcuts.dart';
import '../widgets/lazy_indexed_stack.dart';
import '../widgets/windows_caption_controls.dart';
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

  Widget _buildRootView(int index) {
    switch (index) {
      case 0:
        return const RecommendView();
      case 1:
        return const DiscoverView();
      case 2:
        return const SearchView();
      case 3:
        return const HistoryView();
      case 4:
        return const CloudView();
      case 5:
        return const SettingView();
      case 6:
        return const ProfileView();
      default:
        return const SizedBox.shrink();
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final navProvider = context.watch<NavigationProvider>();
    final settings = context.watch<PersistenceProvider>().settings;
    final shortcutBindings = AppShortcuts.bindingsFromSettings(settings);
    final shortcutsEnabled = settings['globalShortcutsEnabled'] ?? false;

    return AppShortcuts(
      enabled: shortcutsEnabled,
      bindings: shortcutBindings,
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
        body: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SizedBox(
              width: 230,
              child: Container(
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
                    SizedBox(
                      height: 48,
                      width: double.infinity,
                      child: DragToMoveArea(
                        child: const SizedBox.expand(),
                      ),
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
                    child: Stack(
                      children: [
                        Row(
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
                            Expanded(
                              child: DragToMoveArea(
                                child: const SizedBox.expand(),
                              ),
                            ),
                            if (!Platform.isMacOS)
                              const SizedBox(
                                width: WindowsCaptionControls.width,
                              ),
                          ],
                        ),
                        if (!Platform.isMacOS)
                          const Positioned(
                            top: 0,
                            right: 0,
                            child: SizedBox(
                              height: WindowsCaptionControls.height,
                              child: WindowsCaptionControls(),
                            ),
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
                                  LazyIndexedStack(
                                    index: provider.currentRootIndex,
                                    itemCount: 7,
                                    itemBuilder: _buildRootView,
                                    activationVersion:
                                        provider.rootActivationVersion,
                                    recreateOnActivateIndices:
                                        const <int>{3, 4},
                                  ),
                            ),
                      ),
                    ),
                  ),
                  const PlayerBar(),
                ],
              ),
            ),
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
