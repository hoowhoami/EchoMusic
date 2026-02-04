import 'package:flutter/material.dart';
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
import '../../providers/audio_provider.dart';
import '../../providers/user_provider.dart';
import '../../providers/persistence_provider.dart';
import '../../api/music_api.dart';
import '../../theme/app_theme.dart';
import 'package:cached_network_image/cached_network_image.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  int _selectedIndex = 0;

  @override
  void initState() {
    super.initState();
    _initDevice();
  }

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
                    ? [const Color(0xFF1E1E1E), const Color(0xFF000000), const Color(0xFF121212)]
                    : [const Color(0xFFF5F5F7), const Color(0xFFFFFFFF), const Color(0xFFE5E5EA)],
                ),
              ),
            ),
          ),
          
          Column(
            children: [
              Expanded(
                child: Row(
                  children: [
                    // Glass Sidebar (Extends to top)
                    ClipRect(
                      child: BackdropFilter(
                        filter: ImageFilter.blur(sigmaX: modernTheme.glassBlur!, sigmaY: modernTheme.glassBlur!),
                        child: Container(
                          width: 240,
                          decoration: BoxDecoration(
                            color: modernTheme.sidebarColor,
                            border: Border(
                              right: BorderSide(
                                color: modernTheme.dividerColor!,
                                width: 0.5,
                              ),
                            ),
                          ),
                          child: Sidebar(
                            selectedIndex: _selectedIndex,
                            onDestinationSelected: (index) {
                              setState(() {
                                _selectedIndex = index;
                              });
                            },
                          ),
                        ),
                      ),
                    ),
                    
                    // Main Content area
                    Expanded(
                      child: Column(
                        children: [
                          // Top bar for dragging and title (Invisible on sidebar, visible here)
                          SizedBox(
                            height: 52,
                            child: Row(
                              children: [
                                Expanded(child: MoveWindow()),
                                if (!Platform.isMacOS)
                                  const WindowButtons(),
                              ],
                            ),
                          ),
                          Expanded(
                            child: Container(
                              color: Colors.transparent,
                              child: AnimatedSwitcher(
                                duration: const Duration(milliseconds: 300),
                                child: _views[_selectedIndex],
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
              
              // Bottom Player Bar
              const PlayerBar(),
            ],
          ),
        ],
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
