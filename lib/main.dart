import 'dart:async';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:hotkey_manager/hotkey_manager.dart';
import 'package:provider/provider.dart';
import 'package:window_manager/window_manager.dart';
import 'package:tray_manager/tray_manager.dart';
import 'package:media_kit/media_kit.dart';
import 'package:flutter_single_instance/flutter_single_instance.dart';
import 'package:path_provider/path_provider.dart';
import 'package:wakelock_plus/wakelock_plus.dart';
import 'package:echomusic/providers/audio_provider.dart';
import 'package:echomusic/providers/lyric_provider.dart';
import 'package:echomusic/providers/persistence_provider.dart';
import 'package:echomusic/providers/refresh_provider.dart';
import 'package:echomusic/providers/user_provider.dart';
import 'package:echomusic/providers/selection_provider.dart';
import 'package:echomusic/providers/navigation_provider.dart';
import 'theme/app_theme.dart';
import 'ui/screens/loading_screen.dart';
import 'ui/widgets/app_shortcuts.dart';
import 'ui/widgets/auth_listener.dart';
import 'utils/server_orchestrator.dart';
import 'utils/logger.dart';
import 'utils/player_shortcut_actions.dart';

final GlobalKey<NavigatorState> navigatorKey = GlobalKey<NavigatorState>();
bool get _supportsSystemWideHotKeys =>
    Platform.isMacOS || Platform.isWindows || Platform.isLinux;

void main() async {
  HttpOverrides.global = MyHttpOverrides();
  WidgetsFlutterBinding.ensureInitialized();

  await LoggerService.init();
  LoggerService.i('App process starting...');

  // windowManager.ensureInitialized() MUST be called before isFirstInstance()
  // so that the secondary instance's window is hidden immediately on startup,
  // preventing the ghost transparent window in the top-left corner of macOS.
  await windowManager.ensureInitialized();

  // Set onFocus before isFirstInstance() to avoid a race where the gRPC server
  // starts (inside isFirstInstance) but the callback is not yet registered.
  FlutterSingleInstance.onFocus = (_) async {
    LoggerService.i('Focus requested by another instance. Restoring window...');
    if (await windowManager.isMinimized()) await windowManager.restore();
    await windowManager.show();
    await windowManager.focus();
  };

  if (Platform.isMacOS) {
    // Ensure cache directory exists for FlutterSingleInstance PID file
    final cacheDir = await getApplicationCacheDirectory();
    if (!await cacheDir.exists()) {
      await cacheDir.create(recursive: true);
    }
  }

  final instance = FlutterSingleInstance();
  if (!(await instance.isFirstInstance())) {
    LoggerService.i(
      'Another instance is running. Requesting focus and exiting.',
    );
    await instance.focus();
    exit(0);
  }

  LoggerService.i('First instance confirmed.');

  MediaKit.ensureInitialized();

  if (_supportsSystemWideHotKeys) {
    await hotKeyManager.unregisterAll();
  }

  if (!Platform.isWindows) {
    ProcessSignal.sigint.watch().listen((_) {
      unawaited(WakelockPlus.disable());
      unawaited(ServerOrchestrator.stop(reason: 'ProcessSignal.sigint'));
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
        ChangeNotifierProxyProvider2<
          PersistenceProvider,
          LyricProvider,
          AudioProvider
        >(
          create: (_) => AudioProvider(),
          update: (_, p, l, a) => a!
            ..setPersistenceProvider(p)
            ..setLyricProvider(l),
        ),
        ChangeNotifierProxyProvider3<
          PersistenceProvider,
          RefreshProvider,
          AudioProvider,
          UserProvider
        >(
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
  static final _lifecycleChannel = MethodChannel(
    'com.hoowhoami.echomusic/app_lifecycle',
  );
  bool _isExiting = false;

  void _logHotKeyError(String message, Object error, StackTrace stackTrace) {
    LoggerService.e('[hotkey] $message', error, stackTrace);
  }

  void _logTrayError(String message, Object error, StackTrace stackTrace) {
    LoggerService.e('[tray] $message', error, stackTrace);
  }

  Future<void> _runBestEffortExitStep(
    String stepName,
    Future<void> Function() action,
  ) async {
    try {
      await action();
    } catch (e, stackTrace) {
      LoggerService.e(
        '[Exit] $stepName failed during exit',
        e,
        stackTrace,
      );
    }
  }

  Future<void> _showWindowFromTray() async {
    try {
      final minimized = await windowManager.isMinimized();

      if (minimized) {
        await windowManager.restore();
      }

      await windowManager.show();
      await windowManager.focus();
    } catch (e, stackTrace) {
      _logTrayError('_showWindowFromTray failed', e, stackTrace);
      rethrow;
    }
  }

  Future<void> _prepareForAppExit() async {
    final audioProvider = context.read<AudioProvider>();

    await _runBestEffortExitStep(
      '_unregisterGlobalHotKeys',
      _unregisterGlobalHotKeys,
    );

    await _runBestEffortExitStep(
      'audioProvider.prepareForExit',
      audioProvider.prepareForExit,
    );

    await _runBestEffortExitStep(
      'ServerOrchestrator.stop',
      () => ServerOrchestrator.stop(reason: 'app exit'),
    );
  }

  Future<void> _performFullAppExit() async {
    if (_isExiting) {
      return;
    }

    _isExiting = true;

    try {
      await _prepareForAppExit();
      await _runBestEffortExitStep(
        'trayManager.destroy',
        trayManager.destroy,
      );
      await _runBestEffortExitStep(
        'windowManager.destroy',
        windowManager.destroy,
      );
      exit(0);
    } finally {
      _isExiting = false;
    }
  }

  Future<void> _registerGlobalHotKeys() async {
    if (!_supportsSystemWideHotKeys) return;

    for (final command in AppShortcutCommand.values) {
      final hotKey = AppShortcuts.hotKeyFor(command);

      try {
        await hotKeyManager.register(
          hotKey,
          keyDownHandler: (_) {
            if (!mounted) return;
            unawaited(PlayerShortcutActions.invoke(context, command));
          },
        );
      } catch (e, stackTrace) {
        _logHotKeyError(
          'Failed to register ${AppShortcuts.labelFor(command)}',
          e,
          stackTrace,
        );
      }
    }
  }

  Future<void> _unregisterGlobalHotKeys() async {
    if (!_supportsSystemWideHotKeys) return;

    try {
      await hotKeyManager.unregisterAll();
    } catch (e, stackTrace) {
      _logHotKeyError('Failed to unregister global hotkeys', e, stackTrace);
    }
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    windowManager.addListener(this);
    trayManager.addListener(this);
    windowManager.setPreventClose(true);
    _initTray();
    unawaited(_registerGlobalHotKeys());
    if (Platform.isMacOS) {
      _lifecycleChannel.setMethodCallHandler(_onLifecycleCall);
    }
  }

  // Called by Swift's applicationShouldTerminate (Dock right-click → Quit,
  // Cmd+Q) to let Flutter stop mpv before the process exits.
  Future<void> _onLifecycleCall(MethodCall call) async {
    if (call.method == 'prepareToTerminate') {
      await _prepareForAppExit();
    }
  }

  Future<void> _initTray() async {
    try {
      await trayManager.setIcon(
        Platform.isWindows ? 'assets/icons/icon.ico' : 'assets/icons/icon.png',
      );
    } catch (e, stackTrace) {
      _logTrayError('_initTray setIcon failed', e, stackTrace);
      return;
    }

    if (!Platform.isLinux) {
      try {
        await trayManager.setToolTip('EchoMusic');
      } catch (e, stackTrace) {
        _logTrayError('_initTray setToolTip failed', e, stackTrace);
      }
    }

    try {
      final menu = Menu(
        items: [
          MenuItem(key: 'show_window', label: '显示窗口'),
          MenuItem.separator(),
          MenuItem(key: 'exit_app', label: '退出'),
        ],
      );
      await trayManager.setContextMenu(menu);
    } catch (e, stackTrace) {
      _logTrayError('_initTray setContextMenu failed', e, stackTrace);
    }
  }

  @override
  void dispose() {
    unawaited(_unregisterGlobalHotKeys());
    WidgetsBinding.instance.removeObserver(this);
    windowManager.removeListener(this);
    trayManager.removeListener(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.detached) {
      unawaited(_prepareForAppExit());
    }
  }

  @override
  void onWindowClose() async {
    final persistence = context.read<PersistenceProvider>();
    final closeBehavior = persistence.settings['closeBehavior'] ?? 'tray';

    if (closeBehavior == 'exit') {
      await _performFullAppExit();
    } else {
      await windowManager.hide();
    }
  }

  @override
  void onWindowFocus() {}

  @override
  void onWindowRestore() async {
    await _showWindowFromTray();
  }

  @override
  void onTrayIconMouseDown() async {
    if (!Platform.isLinux) {
      await _showWindowFromTray();
    }
  }

  @override
  void onTrayIconMouseUp() async {
    if (Platform.isLinux) {
      await _showWindowFromTray();
    }
  }

  @override
  void onTrayIconRightMouseDown() {
    if (!Platform.isLinux) {
      trayManager.popUpContextMenu();
    }
  }

  @override
  void onTrayIconRightMouseUp() {}

  @override
  void onTrayMenuItemClick(MenuItem menuItem) async {
    if (menuItem.key == 'show_window') {
      await _showWindowFromTray();
    } else if (menuItem.key == 'exit_app') {
      await _performFullAppExit();
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
      selector: (_, provider) =>
          provider.settings['theme'] as String? ?? 'auto',
      builder: (context, theme, child) {
        return MaterialApp(
          title: 'EchoMusic',
          navigatorKey: navigatorKey,
          debugShowCheckedModeBanner: false,
          locale: const Locale('zh', 'CN'),
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
