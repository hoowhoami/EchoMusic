import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:window_manager/window_manager.dart';
import 'providers/audio_provider.dart';
import 'providers/lyric_provider.dart';
import 'providers/persistence_provider.dart';
import 'providers/user_provider.dart';
import 'theme/app_theme.dart';
import 'ui/screens/loading_screen.dart';
import 'utils/server_orchestrator.dart';

void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await windowManager.ensureInitialized();
  
  // Server startup is now handled by LoadingScreen

  WindowOptions windowOptions = const WindowOptions(
    size: Size(1000, 700),
    minimumSize: Size(800, 600),
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
        ChangeNotifierProxyProvider2<PersistenceProvider, LyricProvider, AudioProvider>(
          create: (_) => AudioProvider(),
          update: (context, persistence, lyric, audio) {
            return audio!
              ..setPersistenceProvider(persistence)
              ..setLyricProvider(lyric);
          },
        ),
      ],
      child: const WindowHandler(child: MyApp()),
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

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    final persistence = context.watch<PersistenceProvider>();
    final themeMode = _getThemeMode(persistence.settings['theme']);

    return MaterialApp(
      title: 'EchoMusic',
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
