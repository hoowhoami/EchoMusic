import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'dart:ui';
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
import '../../providers/user_provider.dart';
import '../../providers/persistence_provider.dart';
import '../../api/music_api.dart';
import '../../theme/app_theme.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  int _selectedIndex = 0;
  final List<int> _navigationHistory = [0];
  int _historyIndex = 0;
  final GlobalKey<NavigatorState> _navigatorKey = GlobalKey<NavigatorState>();

  @override
  void initState() {
    super.initState();
    _initDevice();
  }

  void _navigateTo(int index) {
    if (index == _selectedIndex) return;

    setState(() {
      // Remove forward history when navigating to a new page
      if (_historyIndex < _navigationHistory.length - 1) {
        _navigationHistory.removeRange(_historyIndex + 1, _navigationHistory.length);
      }

      _navigationHistory.add(index);
      _historyIndex = _navigationHistory.length - 1;
      _selectedIndex = index;

      // Pop to root of nested navigator when changing views
      _navigatorKey.currentState?.popUntil((route) => route.isFirst);
    });
  }

  void _pushRoute(Widget page) {
    _navigatorKey.currentState?.push(
      CupertinoPageRoute(builder: (_) => page),
    ).then((_) {
      if (mounted) setState(() {});
    });
  }

  void _goBack() {
    if (_navigatorKey.currentState?.canPop() ?? false) {
      _navigatorKey.currentState?.pop();
      if (mounted) setState(() {});
      return;
    }

    if (_historyIndex > 0) {
      setState(() {
        _historyIndex--;
        _selectedIndex = _navigationHistory[_historyIndex];
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

  void _refresh() {
    setState(() {
      // Trigger rebuild to refresh current view
    });
  }

  bool get canGoBack => (_navigatorKey.currentState?.canPop() ?? false) || _historyIndex > 0;
  bool get canGoForward => _historyIndex < _navigationHistory.length - 1;

  Future<void> _initDevice() async {
    final persistence = context.read<PersistenceProvider>();
    if (persistence.device == null) {
      final device = await MusicApi.registerDevice();
      if (device != null) {
        await persistence.setDevice(device);
      }
    }
    
    // Auto fetch user data if authenticated
    final userProvider = context.read<UserProvider>();
    if (userProvider.isAuthenticated) {
      userProvider.fetchAllUserData();
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
    final modernTheme = theme.extension<AppModernTheme>()!;

    return Scaffold(
      body: Stack(
        children: [
          // Background Gradient
          Positioned.fill(
            child: Container(
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: [
                    theme.scaffoldBackgroundColor,
                    theme.colorScheme.surface,
                    theme.colorScheme.surfaceContainerHighest.withAlpha(100),
                  ],
                ),
              ),
            ),
          ),

          Column(
            children: [
              Expanded(
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    // Glass Sidebar (Extends to top, above player)
                    ClipRect(
                      child: BackdropFilter(
                        filter: ImageFilter.blur(sigmaX: modernTheme.glassBlur!, sigmaY: modernTheme.glassBlur!),
                        child: Container(
                          width: 260,
                          height: double.infinity,
                          decoration: BoxDecoration(
                            color: modernTheme.sidebarColor,
                            border: Border(
                              right: BorderSide(
                                color: modernTheme.dividerColor!,
                                width: 0.8,
                              ),
                            ),
                          ),
                          child: Column(
                            children: [
                              // Window Control & Drag Area
                              SizedBox(
                                height: 48,
                                child: MoveWindow(),
                              ),
                              // Scrollable Sidebar Content
                              Expanded(
                                child: Sidebar(
                                  selectedIndex: _selectedIndex,
                                  onDestinationSelected: _navigateTo,
                                  onPushRoute: _pushRoute,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),

                    // Main Content area
                    Expanded(
                      child: Column(
                        children: [
                          // Top bar for dragging and title
                          SizedBox(
                            height: 48,
                            child: Row(
                              children: [
                                const SizedBox(width: 12),
                                _buildNavButton(
                                  icon: CupertinoIcons.chevron_left,
                                  onPressed: canGoBack ? _goBack : null,
                                  tooltip: '后退',
                                ),
                                const SizedBox(width: 8),
                                _buildNavButton(
                                  icon: CupertinoIcons.chevron_right,
                                  onPressed: canGoForward ? _goForward : null,
                                  tooltip: '前进',
                                ),
                                const SizedBox(width: 8),
                                _buildNavButton(
                                  icon: CupertinoIcons.refresh,
                                  onPressed: _refresh,
                                  tooltip: '刷新',
                                ),
                                Expanded(child: MoveWindow()),
                                if (!Platform.isMacOS)
                                  const WindowButtons(),
                              ],
                            ),
                          ),
                          // Content View
                          Expanded(
                            child: Container(
                              decoration: BoxDecoration(
                                color: theme.scaffoldBackgroundColor,
                              ),
                              child: Navigator(
                                key: _navigatorKey,
                                observers: [
                                  _NavigationObserver(() {
                                    if (mounted) {
                                      WidgetsBinding.instance.addPostFrameCallback((_) {
                                        if (mounted) setState(() {});
                                      });
                                    }
                                  }),
                                ],
                                onGenerateRoute: (settings) {
                                  return PageRouteBuilder(
                                    pageBuilder: (context, animation, secondaryAnimation) {
                                      return IndexedStack(
                                        index: _selectedIndex,
                                        children: _views,
                                      );
                                    },
                                  );
                                },
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),

              // Bottom Player Bar (Fixed at bottom)
              const PlayerBar(),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildNavButton({
    required IconData icon,
    required VoidCallback? onPressed,
    required String tooltip,
  }) {
    final theme = Theme.of(context);
    final isEnabled = onPressed != null;

    return Tooltip(
      message: tooltip,
      child: IconButton(
        icon: Icon(
          icon,
          size: 18,
          color: isEnabled
              ? theme.colorScheme.onSurface
              : theme.colorScheme.onSurface.withAlpha(60),
        ),
        onPressed: onPressed,
        padding: EdgeInsets.zero,
        constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
        splashRadius: 18,
      ),
    );
  }
}

class WindowButtons extends StatelessWidget {
  const WindowButtons({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    final buttonColors = WindowButtonColors(
        iconNormal: theme.colorScheme.onSurfaceVariant,
        mouseOver: theme.colorScheme.onSurface.withAlpha(25),
        mouseDown: theme.colorScheme.onSurface.withAlpha(50),
        iconMouseOver: theme.colorScheme.onSurface,
        iconMouseDown: theme.colorScheme.onSurface);

    final closeButtonColors = WindowButtonColors(
        mouseOver: const Color(0xFFD32F2F),
        mouseDown: const Color(0xFFB71C1C),
        iconNormal: theme.colorScheme.onSurfaceVariant,
        iconMouseOver: Colors.white);

    return Row(
      children: [
        MinimizeWindowButton(colors: buttonColors),
        MaximizeWindowButton(colors: buttonColors),
        CloseWindowButton(colors: closeButtonColors),
      ],
    );
  }
}

class _NavigationObserver extends NavigatorObserver {
  final VoidCallback onStateChanged;

  _NavigationObserver(this.onStateChanged);

  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) {
    super.didPush(route, previousRoute);
    onStateChanged();
  }

  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) {
    super.didPop(route, previousRoute);
    onStateChanged();
  }

  @override
  void didRemove(Route<dynamic> route, Route<dynamic>? previousRoute) {
    super.didRemove(route, previousRoute);
    onStateChanged();
  }

  @override
  void didReplace({Route<dynamic>? newRoute, Route<dynamic>? oldRoute}) {
    super.didReplace(newRoute: newRoute, oldRoute: oldRoute);
    onStateChanged();
  }
}
