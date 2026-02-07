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
  
  // 简单的历史记录：只记录状态变更（分类索引 + 歌单ID）
  final List<({int index, dynamic playlistId})> _history = [(index: 0, playlistId: null)];
  int _historyIndex = 0;
  
  final GlobalKey<NavigatorState> _navigatorKey = GlobalKey<NavigatorState>();

  @override
  void initState() {
    super.initState();
    _initDevice();
  }

  // 辅助方法：检查两个状态是否相同
  bool _isSameState(int index, dynamic playlistId) {
    return _selectedIndex == index && _selectedPlaylistId == playlistId;
  }

  void _navigateTo(int index) {
    // 1. 如果点击的是当前已激活的分类，且不在歌单里，则什么都不做
    if (_isSameState(index, null)) return;

    context.read<SelectionProvider>().reset();

    setState(() {
      // 2. 清理当前位置之后的前进历史
      if (_historyIndex < _history.length - 1) {
        _history.removeRange(_historyIndex + 1, _history.length);
      }
      
      // 3. 记录新状态
      _history.add((index: index, playlistId: null));
      _historyIndex = _history.length - 1;
      
      _selectedIndex = index;
      _selectedPlaylistId = null;
      
      // 4. 重置 Navigator 到首页
      _navigatorKey.currentState?.popUntil((route) => route.isFirst);
    });
  }

  void _pushRoute(Widget page, {dynamic playlistId}) {
    // 1. 如果点击的是当前已经在看的歌单，则什么都不做
    if (_isSameState(_selectedIndex, playlistId)) return;
    
    context.read<SelectionProvider>().reset();
    
    setState(() {
      if (_historyIndex < _history.length - 1) {
        _history.removeRange(_historyIndex + 1, _history.length);
      }
      
      _history.add((index: _selectedIndex, playlistId: playlistId));
      _historyIndex = _history.length - 1;
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
    if (_historyIndex > 0) {
      context.read<SelectionProvider>().reset();
      
      setState(() {
        _historyIndex--;
        final state = _history[_historyIndex];
        
        // 判定是退回到上一个分类，还是退回到当前分类的根目录
        if (state.index != _selectedIndex) {
          _selectedIndex = state.index;
          _selectedPlaylistId = state.playlistId;
          // 切换分类时必须清空 Navigator
          _navigatorKey.currentState?.popUntil((route) => route.isFirst);
        } else {
          // 在同一个分类内回退（通常是从歌单详情页退回分类根目录）
          _selectedPlaylistId = state.playlistId;
          if (_selectedPlaylistId == null) {
            _navigatorKey.currentState?.popUntil((route) => route.isFirst);
          } else {
            // 如果历史记录里上一步也是个歌单，则 pop 当前详情页即可
            if (_navigatorKey.currentState?.canPop() ?? false) {
              _navigatorKey.currentState?.pop();
            }
          }
        }
      });
    }
  }

  void _goForward() {
    if (_historyIndex < _history.length - 1) {
      context.read<SelectionProvider>().reset();
      setState(() {
        _historyIndex++;
        final state = _history[_historyIndex];
        
        if (state.index != _selectedIndex) {
          _selectedIndex = state.index;
        }
        _selectedPlaylistId = state.playlistId;
        // 注意：前进到详情页在当前 Navigator 结构下需要重构以完美支持
      });
    }
  }

  bool get canGoBack => _historyIndex > 0;
  bool get canGoForward => _historyIndex < _history.length - 1;

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
                          observers: [
                            _NavigationObserver((route, prevRoute) {
                              // 当用户通过手势或代码 pop 详情页时，同步侧边栏高亮状态
                              if (prevRoute is CupertinoPageRoute && route?.settings.name == 'root') {
                                WidgetsBinding.instance.addPostFrameCallback((_) {
                                  if (mounted && _selectedPlaylistId != null) {
                                    setState(() {
                                      _selectedPlaylistId = null;
                                      // 尝试修正历史索引位置，使“后退”按钮在手动 pop 后依然合乎逻辑
                                      if (_historyIndex > 0 && _history[_historyIndex - 1].playlistId == null) {
                                        _historyIndex--;
                                      }
                                    });
                                  }
                                });
                              }
                            })
                          ],
                          onGenerateRoute: (settings) => PageRouteBuilder(
                            settings: const RouteSettings(name: 'root'),
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
  final Function(Route?, Route?) onStateChanged;
  _NavigationObserver(this.onStateChanged);
  @override
  void didPush(Route route, Route? prev) => onStateChanged(route, prev);
  @override
  void didPop(Route route, Route? prev) => onStateChanged(prev, route);
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