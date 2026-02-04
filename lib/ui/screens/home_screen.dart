import 'package:flutter/material.dart';
import 'dart:ui';
import 'package:provider/provider.dart';
import '../widgets/sidebar.dart';
import '../widgets/player_bar.dart';
import '../widgets/custom_title_bar.dart';
import 'explore_view.dart';
import 'search_view.dart';
import 'rank_view.dart';
import 'library_view.dart';
import '../../providers/audio_provider.dart';
import '../../providers/lyric_provider.dart';
import '../../providers/persistence_provider.dart';
import '../../api/music_api.dart';

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
  }

  final List<Widget> _views = [
    const ExploreView(),
    const RankView(),
    const SearchView(),
    const LibraryView(),
  ];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Stack(
        children: [
          // Background Gradient
          Positioned.fill(
            child: Container(
              decoration: const BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: [
                    Color(0xFF0D1B2A),
                    Color(0xFF000814),
                    Color(0xFF000000),
                  ],
                ),
              ),
            ),
          ),
          
          Column(
            children: [
              const CustomTitleBar(),
              Expanded(
                child: Row(
                  children: [
                    // Glass Sidebar
                    ClipRect(
                      child: BackdropFilter(
                        filter: ImageFilter.blur(sigmaX: 10, sigmaY: 10),
                        child: Container(
                          width: 240,
                          decoration: BoxDecoration(
                            color: Colors.black.withOpacity(0.4),
                            border: Border(
                              right: BorderSide(
                                color: Colors.white.withOpacity(0.05),
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
                    
                    // Main Content
                    Expanded(
                      child: AnimatedSwitcher(
                        duration: const Duration(milliseconds: 300),
                        child: _views[_selectedIndex],
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
