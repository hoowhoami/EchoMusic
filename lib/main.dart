import 'dart:io';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:window_manager/window_manager.dart';
import 'package:tray_manager/tray_manager.dart';
import 'package:just_audio_background/just_audio_background.dart';
import 'package:echomusic/providers/audio_provider.dart';
import 'package:echomusic/providers/lyric_provider.dart';
import 'package:echomusic/providers/persistence_provider.dart';
import 'package:echomusic/providers/refresh_provider.dart';
import 'package:echomusic/providers/user_provider.dart';
import 'package:echomusic/providers/selection_provider.dart';
import 'theme/app_theme.dart';
import 'ui/screens/loading_screen.dart';
import 'ui/widgets/auth_listener.dart';
import 'utils/server_orchestrator.dart';

final GlobalKey<NavigatorState> navigatorKey = GlobalKey<NavigatorState>();

void main() async {
  HttpOverrides.global = MyHttpOverrides();
  WidgetsFlutterBinding.ensureInitialized();
  
  await JustAudioBackground.init(
    androidNotificationChannelId: 'com.ryanheise.bg_demo.channel.audio',
    androidNotificationChannelName: 'Audio playback',
    androidNotificationOngoing: true,
  );

  await windowManager.ensureInitialized();
  
  if (!Platform.isWindows) {
    ProcessSignal.sigint.watch().listen((_) {
      ServerOrchestrator.stop();
      exit(0);
    });
  }

  WindowOptions windowOptions = const WindowOptions(
    size: Size(1100, 750),
    minimumSize: Size(960, 700),
    center: true,
    backgroundColor: Colors.transparent,
    skipTaskbar: false,
    titleBarStyle: TitleBarStyle.hidden,
  );
  
  windowManager.waitUntilReadyToShow(windowOptions, () async {
    await windowManager.show();
    await windowManager.focus();
  });

  runApp(
    MultiProvider(
      providers: [
        ChangeNotifierProvider(create: (_) => PersistenceProvider()),
        ChangeNotifierProvider(create: (_) => RefreshProvider()),
        ChangeNotifierProxyProvider2<PersistenceProvider, RefreshProvider, UserProvider>(
          create: (_) => UserProvider(),
          update: (_, p, r, u) => u!
            ..setPersistenceProvider(p)
            ..setRefreshProvider(r),
        ),
        ChangeNotifierProvider(create: (_) => LyricProvider()),
        ChangeNotifierProvider(create: (_) => SelectionProvider()),
        ChangeNotifierProxyProvider2<PersistenceProvider, LyricProvider, AudioProvider>(
          create: (_) => AudioProvider(),
          update: (_, p, l, a) => a!..setPersistenceProvider(p)..setLyricProvider(l),
        ),
      ],
      child: const WindowHandler(child: AuthListener(child: MyApp())),
    ),
  );
}

class WindowHandler extends StatefulWidget {
  final Widget child;
  const WindowHandler({super.key, required this.child});
  @override
  State<WindowHandler> createState() => _WindowHandlerState();
}

class _WindowHandlerState extends State<WindowHandler> with WindowListener, TrayListener, WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    windowManager.addListener(this);
    trayManager.addListener(this);
    windowManager.setPreventClose(true);
    _initTray();
  }

  Future<void> _initTray() async {
    await trayManager.setIcon(
      Platform.isWindows ? 'assets/icons/icon.ico' : 'assets/icons/icon.png',
    );
    
    List<MenuItem> items = [
      MenuItem(
        key: 'show_window',
        label: '显示窗口',
      ),
      MenuItem.separator(),
      MenuItem(
        key: 'exit_app',
        label: '退出',
      ),
    ];
    
    Menu menu = Menu(items: items);
    await trayManager.setContextMenu(menu);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    windowManager.removeListener(this);
    trayManager.removeListener(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.detached) {
      ServerOrchestrator.stop();
    }
  }

  @override
  void onWindowClose() async {
    await windowManager.hide();
  }

  @override
  void onWindowFocus() async {
    bool isVisible = await windowManager.isVisible();
    if (!isVisible) {
      await windowManager.show();
    }
    await windowManager.focus();
    setState(() {});
  }

  @override
  void onWindowRestore() async {
    await windowManager.show();
    await windowManager.focus();
  }

  @override
  void onTrayIconMouseDown() {
    windowManager.show();
    windowManager.focus();
  }

  @override
  void onTrayIconRightMouseDown() {
    trayManager.popUpContextMenu();
  }

  @override
  void onTrayMenuItemClick(MenuItem menuItem) {
    if (menuItem.key == 'show_window') {
      windowManager.show();
      windowManager.focus();
    } else if (menuItem.key == 'exit_app') {
      ServerOrchestrator.stop();
      windowManager.destroy();
    }
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

class MyHttpOverrides extends HttpOverrides {
  @override
  HttpClient createHttpClient(SecurityContext? context) {
    return super.createHttpClient(context)..badCertificateCallback = (_, __, ___) => true;
  }
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});
  @override
  Widget build(BuildContext context) {
    final theme = context.watch<PersistenceProvider>().settings['theme'];
    return MaterialApp(
      title: 'EchoMusic',
      navigatorKey: navigatorKey,
      debugShowCheckedModeBanner: false,
      themeMode: theme == 'dark' ? ThemeMode.dark : (theme == 'light' ? ThemeMode.light : ThemeMode.system),
      theme: AppTheme.light(),
      darkTheme: AppTheme.dark(),
      home: const LoadingScreen(),
    );
  }
}
