import 'dart:io';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:window_manager/window_manager.dart';
import 'providers/audio_provider.dart';
import 'providers/lyric_provider.dart';
import 'providers/persistence_provider.dart';
import 'providers/user_provider.dart';
import 'providers/selection_provider.dart';
import 'theme/app_theme.dart';
import 'ui/screens/loading_screen.dart';
import 'ui/widgets/auth_listener.dart';
import 'utils/server_orchestrator.dart';

void _handleExit() {
  debugPrint('[Main] Signal received, stopping server...');
  ServerOrchestrator.stop();
  exit(0);
}

class MyHttpOverrides extends HttpOverrides {
  @override
  HttpClient createHttpClient(SecurityContext? context) {
    return super.createHttpClient(context)
      ..badCertificateCallback = (X509Certificate cert, String host, int port) => true;
  }
}

void main() async {
  HttpOverrides.global = MyHttpOverrides();
  WidgetsFlutterBinding.ensureInitialized();
  await windowManager.ensureInitialized();
  
  // 监听进程终止信号，确保清理服务进程
  if (!Platform.isWindows) {
    ProcessSignal.sigint.watch().listen((_) => _handleExit());
    ProcessSignal.sigterm.watch().listen((_) => _handleExit());
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
        ChangeNotifierProxyProvider<PersistenceProvider, UserProvider>(
          create: (_) => UserProvider(),
          update: (context, persistence, user) {
            return user!..setPersistenceProvider(persistence);
          },
        ),
        ChangeNotifierProvider(create: (_) => LyricProvider()),
        ChangeNotifierProvider(create: (_) => SelectionProvider()),
        ChangeNotifierProxyProvider2<PersistenceProvider, LyricProvider, AudioProvider>(
          create: (_) => AudioProvider(),
          update: (context, persistence, lyric, audio) {
            return audio!
              ..setPersistenceProvider(persistence)
              ..setLyricProvider(lyric);
          },
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

class _WindowHandlerState extends State<WindowHandler> with WindowListener {
  @override
  void initState() {
    super.initState();
    windowManager.addListener(this);
    windowManager.setPreventClose(true);
  }

  @override
  void dispose() {
    windowManager.removeListener(this);
    super.dispose();
  }

  @override
  void onWindowClose() async {
    bool isPreventClose = await windowManager.isPreventClose();
    if (isPreventClose) {
      ServerOrchestrator.stop();
      await Future.delayed(const Duration(milliseconds: 200));
      await windowManager.destroy();
    }
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

final GlobalKey<NavigatorState> navigatorKey = GlobalKey<NavigatorState>();

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    final persistence = context.watch<PersistenceProvider>();
    final themeMode = _getThemeMode(persistence.settings['theme']);

    return MaterialApp(
      title: 'EchoMusic',
      navigatorKey: navigatorKey,
      debugShowCheckedModeBanner: false,
      themeMode: themeMode,
      theme: AppTheme.light(),
      darkTheme: AppTheme.dark(),
      home: const LoadingScreen(),
    );
  }

  ThemeMode _getThemeMode(String? theme) {
    switch (theme) {
      case 'light': return ThemeMode.light;
      case 'dark': return ThemeMode.dark;
      default: return ThemeMode.system;
    }
  }
}
