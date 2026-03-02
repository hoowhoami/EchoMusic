import 'dart:io';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:window_manager/window_manager.dart';
import 'package:tray_manager/tray_manager.dart';
import 'package:just_audio_media_kit/just_audio_media_kit.dart';
import 'package:echomusic/providers/audio_provider.dart';
import 'package:echomusic/providers/lyric_provider.dart';
import 'package:echomusic/providers/persistence_provider.dart';
import 'package:echomusic/providers/refresh_provider.dart';
import 'package:echomusic/providers/user_provider.dart';
import 'package:echomusic/providers/selection_provider.dart';
import 'package:echomusic/providers/navigation_provider.dart';
import 'theme/app_theme.dart';
import 'ui/screens/loading_screen.dart';
import 'ui/widgets/auth_listener.dart';
import 'utils/server_orchestrator.dart';
import 'utils/logger.dart';
import 'utils/single_instance.dart';

final GlobalKey<NavigatorState> navigatorKey = GlobalKey<NavigatorState>();

void main() async {
  HttpOverrides.global = MyHttpOverrides();

  // ──────────────────────────────────────────────────────────────────────────
  // Single-instance check MUST run before WidgetsFlutterBinding.ensureInitialized().
  // The secondary instance exits here before any native plugin (including
  // tray_manager) is registered — eliminating ghost menu-bar icons on macOS.
  // ──────────────────────────────────────────────────────────────────────────
  if (!await SingleInstance.acquire()) {
    exit(0); // another instance is running; focus request already sent
  }

  WidgetsFlutterBinding.ensureInitialized();

  await LoggerService.init();
  LoggerService.i('App starting (primary instance).');

  await windowManager.ensureInitialized();

  // Listen for focus requests from secondary instances.
  // windowManager must be initialized before registering this.
  SingleInstance.listenForFocus(() async {
    LoggerService.i('Focus requested by another instance. Restoring window...');
    await windowManager.show();
    await windowManager.focus();
  });

  JustAudioMediaKit.ensureInitialized(
    linux: true,
    windows: true,
    macOS: true,
    android: false,
    iOS: false,
  );

  if (!Platform.isWindows) {
    ProcessSignal.sigint.watch().listen((_) async {
      ServerOrchestrator.stop();
      await SingleInstance.release();
      exit(0);
    });
  }

  const WindowOptions windowOptions = WindowOptions(
    size: Size(1100, 750),
    minimumSize: Size(1000, 700),
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
        ChangeNotifierProvider(create: (_) => NavigationProvider()),
        ChangeNotifierProxyProvider<PersistenceProvider, LyricProvider>(
          create: (_) => LyricProvider(),
          update: (_, p, l) => l!..setPersistenceProvider(p),
        ),
        ChangeNotifierProxyProvider2<PersistenceProvider, LyricProvider, AudioProvider>(
          create: (_) => AudioProvider(),
          update: (_, p, l, a) => a!..setPersistenceProvider(p)..setLyricProvider(l),
        ),
        ChangeNotifierProxyProvider3<PersistenceProvider, RefreshProvider, AudioProvider, UserProvider>(
          create: (_) => UserProvider(),
          update: (_, p, r, a, u) => u!
            ..setPersistenceProvider(p)
            ..setRefreshProvider(r)
            ..setAudioProvider(a),
        ),
        ChangeNotifierProvider(create: (_) => SelectionProvider()),
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

class _WindowHandlerState extends State<WindowHandler>
    with WindowListener, TrayListener, WidgetsBindingObserver {
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

    final menu = Menu(
      items: [
        MenuItem(key: 'show_window', label: '显示窗口'),
        MenuItem.separator(),
        MenuItem(key: 'exit_app', label: '退出'),
      ],
    );
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
    // Hide to tray on all platforms; tray icon lets the user restore.
    await windowManager.hide();
  }

  @override
  void onWindowFocus() {}

  @override
  void onWindowRestore() async {
    await windowManager.show();
    await windowManager.focus();
  }

  @override
  void onTrayIconMouseDown() async {
    await windowManager.show();
    await windowManager.focus();
  }

  @override
  void onTrayIconRightMouseDown() {
    trayManager.popUpContextMenu();
  }

  @override
  void onTrayMenuItemClick(MenuItem menuItem) async {
    if (menuItem.key == 'show_window') {
      await windowManager.show();
      await windowManager.focus();
    } else if (menuItem.key == 'exit_app') {
      ServerOrchestrator.stop();
      await SingleInstance.release();
      await windowManager.destroy();
    }
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

class MyHttpOverrides extends HttpOverrides {
  @override
  HttpClient createHttpClient(SecurityContext? context) {
    return super.createHttpClient(context)
      ..badCertificateCallback = (_, _, _) => true;
  }
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});
  @override
  Widget build(BuildContext context) {
    return Selector<PersistenceProvider, String>(
      selector: (_, provider) => provider.settings['theme'] as String? ?? 'auto',
      builder: (context, theme, child) {
        return MaterialApp(
          title: 'EchoMusic',
          navigatorKey: navigatorKey,
          debugShowCheckedModeBanner: false,
          themeMode: theme == 'dark'
              ? ThemeMode.dark
              : (theme == 'light' ? ThemeMode.light : ThemeMode.system),
          theme: AppTheme.light(),
          darkTheme: AppTheme.dark(),
          home: const LoadingScreen(),
        );
      },
    );
  }
}
