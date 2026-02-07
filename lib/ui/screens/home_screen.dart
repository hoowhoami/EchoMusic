import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import 'package:bitsdojo_window/bitsdojo_window.dart';
import 'dart:io';
import '../widgets/sidebar.dart';
import '../widgets/player_bar.dart';
import '../widgets/custom_dialog.dart';
import 'recommend_view.dart';
import 'discover_view.dart';
import 'search_view.dart';
import 'setting_view.dart';
import 'history_view.dart';
import 'cloud_view.dart';
import 'profile_view.dart';
import '../../providers/user_provider.dart';
import '../../providers/persistence_provider.dart';
import '../../providers/selection_provider.dart';
import '../../api/music_api.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  int _selectedIndex = 0;
  dynamic _selectedPlaylistId;
  final List<int> _navigationHistory = [0];
  int _historyIndex = 0;
  final GlobalKey<NavigatorState> _navigatorKey = GlobalKey<NavigatorState>();

  @override
  void initState() {
    super.initState();
    _initDevice();
  }

  void _navigateTo(int index) {
    if (index == _selectedIndex && _selectedPlaylistId == null) return;

    context.read<SelectionProvider>().reset();

    setState(() {
      // If we're clicking the same category but a playlist was open, 
      // just clear the playlist and pop to root, don't add to history.
      if (index != _selectedIndex) {
        if (_historyIndex < _navigationHistory.length - 1) {
          _navigationHistory.removeRange(_historyIndex + 1, _navigationHistory.length);
        }
        _navigationHistory.add(index);
        _historyIndex = _navigationHistory.length - 1;
        _selectedIndex = index;
      }
      
      _selectedPlaylistId = null;
      _navigatorKey.currentState?.popUntil((route) => route.isFirst);
    });
  }

  void _pushRoute(Widget page, {dynamic playlistId}) {
    if (playlistId != null && _selectedPlaylistId == playlistId) return;
    
    context.read<SelectionProvider>().reset();
    setState(() {
      _selectedPlaylistId = playlistId;
    });
    _navigatorKey.currentState?.push(
      CupertinoPageRoute(
        builder: (_) => page,
        settings: RouteSettings(arguments: playlistId),
      ),
    );
  }

  void _goBack() {
    if (_navigatorKey.currentState?.canPop() ?? false) {
      _navigatorKey.currentState?.pop();
      return;
    }
    if (_historyIndex > 0) {
      context.read<SelectionProvider>().reset();
      setState(() {
        _historyIndex--;
        _selectedIndex = _navigationHistory[_historyIndex];
        _selectedPlaylistId = null;
      });
    }
  }

  void _goForward() {
    if (_historyIndex < _navigationHistory.length - 1) {
      setState(() {
        _historyIndex++;
        _selectedIndex = _navigationHistory[_historyIndex];
      });
    }
  }

  bool get canGoBack => (_navigatorKey.currentState?.canPop() ?? false) || _historyIndex > 0;
  bool get canGoForward => _historyIndex < _navigationHistory.length - 1;

  Future<void> _initDevice() async {
    final persistence = context.read<PersistenceProvider>();
    if (persistence.device == null) {
      final device = await MusicApi.registerDevice();
      if (device != null) await persistence.setDevice(device);
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
                          selectedPlaylistId: _selectedPlaylistId,
                          onDestinationSelected: _navigateTo,
                          onPushRoute: _pushRoute,
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
                            Expanded(child: MoveWindow()),
                            if (!Platform.isMacOS) const WindowButtons(),
                          ],
                        ),
                      ),
                      Expanded(
                        child: Navigator(
                          key: _navigatorKey,
                          observers: [_NavigationObserver((route) {
                            if (mounted) {
                              WidgetsBinding.instance.addPostFrameCallback((_) {
                                if (mounted) {
                                  setState(() {
                                    _selectedPlaylistId = route?.settings.arguments;
                                  });
                                }
                              });
                            }
                          })],
                          onGenerateRoute: (settings) => PageRouteBuilder(
                            pageBuilder: (context, _, __) => IndexedStack(index: _selectedIndex, children: _views),
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

class _NavigationObserver extends NavigatorObserver {
  final Function(Route?) onStateChanged;
  _NavigationObserver(this.onStateChanged);
  @override
  void didPush(Route route, Route? prev) => onStateChanged(route);
  @override
  void didPop(Route route, Route? prev) => onStateChanged(prev);
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