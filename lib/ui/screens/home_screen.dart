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
    );
  }

  void _goBack() {
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

  bool get canGoBack => _historyIndex > 0;
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
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final modernTheme = Theme.of(context).extension<AppModernTheme>()!;

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
                  colors: isDark
                    ? [const Color(0xFF0F172A), const Color(0xFF020617), const Color(0xFF1E1B4B)]
                    : [const Color(0xFFF8FAFC), const Color(0xFFF1F5F9), const Color(0xFFEEF2FF)],
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
                          // Content View (scrollable via ScrollableContent in each view)
                          Expanded(
                            child: Container(
                              color: Colors.transparent,
                              child: Navigator(
                                key: _navigatorKey,
                                onGenerateRoute: (settings) {
                                  return PageRouteBuilder(
                                    pageBuilder: (context, animation, secondaryAnimation) {
                                      return FadeTransition(
                                        opacity: animation,
                                        child: _views[_selectedIndex],
                                      );
                                    },
                                    transitionDuration: const Duration(milliseconds: 300),
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
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final isEnabled = onPressed != null;

    return Tooltip(
      message: tooltip,
      child: IconButton(
        icon: Icon(
          icon,
          size: 18,
          color: isEnabled
              ? (isDark ? Colors.white70 : Colors.black.withAlpha(180))
              : (isDark ? Colors.white24 : Colors.black.withAlpha(60)),
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
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final buttonColors = WindowButtonColors(
        iconNormal: isDark ? Colors.white54 : Colors.black54,
        mouseOver: isDark ? Colors.white10 : Colors.black12,
        mouseDown: isDark ? Colors.white24 : Colors.black26,
        iconMouseOver: isDark ? Colors.white : Colors.black,
        iconMouseDown: isDark ? Colors.white : Colors.black);

    final closeButtonColors = WindowButtonColors(
        mouseOver: const Color(0xFFD32F2F),
        mouseDown: const Color(0xFFB71C1C),
        iconNormal: isDark ? Colors.white54 : Colors.black54,
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
