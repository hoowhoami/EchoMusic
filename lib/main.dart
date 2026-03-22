import 'dart:async';
import 'dart:convert';
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
import 'package:shared_preferences/shared_preferences.dart';

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

  // Load persistence logic for window size and position
  final prefs = await SharedPreferences.getInstance();
  final settingsJson = prefs.getString('app_settings');
  bool rememberWindowSize = false;
  if (settingsJson != null) {
    final settings = jsonDecode(settingsJson);
    rememberWindowSize = settings['rememberWindowSize'] ?? false;
  }

  Size? savedSize;
  Offset? savedPosition;
  if (rememberWindowSize) {
    final sizeJson = prefs.getString('window_size');
    if (sizeJson != null) {
      final map = jsonDecode(sizeJson);
      savedSize = Size(map['width'], map['height']);
    }
    final posJson = prefs.getString('window_position');
    if (posJson != null) {
      final map = jsonDecode(posJson);
      savedPosition = Offset(map['x'], map['y']);
    }
  }

  final WindowOptions windowOptions = WindowOptions(
    size: savedSize ?? const Size(1100, 750),
    minimumSize: const Size(1050, 700),
    center: savedPosition == null,
    backgroundColor: Colors.transparent,
    skipTaskbar: false,
    titleBarStyle: TitleBarStyle.hidden,
  );

  windowManager.waitUntilReadyToShow(windowOptions, () async {
    if (rememberWindowSize && savedPosition != null) {
      await windowManager.setPosition(savedPosition);
    }
    await windowManager.show();
    await windowManager.focus();

    // Fix for Windows occasionally having blank space on the right on startup.
    // Re-applying the size after a short delay forces a layout refresh.
    if (Platform.isWindows) {
      await Future.delayed(const Duration(milliseconds: 200));
      final size = await windowManager.getSize();
      await windowManager.setSize(Size(size.width + 0.1, size.height + 0.1));
      await windowManager.setSize(size);
    }
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
  int _hotKeySyncVersion = 0;
  bool? _globalHotKeysEnabled;
  String? _globalHotKeysSignature;
  PersistenceProvider? _persistenceProvider;

  void _logHotKeyError(String message, Object error, StackTrace stackTrace) {
    LoggerService.e('[hotkey] $message', error, stackTrace);
  }

  void _logTrayError(String message, Object error, StackTrace stackTrace) {
    LoggerService.e('[tray] $message', error, stackTrace);
  }

  bool _resolveGlobalHotKeysEnabled(PersistenceProvider persistence) {
    return persistence.settings['globalShortcutsEnabled'] ?? false;
  }

  String _resolveGlobalHotKeysSignature(PersistenceProvider persistence) {
    final bindings = persistence.settings[AppShortcuts.bindingsSettingKey];
    if (bindings is! Map) return '{}';
    return jsonEncode(bindings);
  }

  void _handlePersistenceChanged() {
    final persistence = _persistenceProvider;
    if (persistence == null || !persistence.isLoaded) return;

    final enabled = _resolveGlobalHotKeysEnabled(persistence);
    final signature = _resolveGlobalHotKeysSignature(persistence);
    if (_globalHotKeysEnabled == enabled &&
        _globalHotKeysSignature == signature) {
      return;
    }

    unawaited(_syncGlobalHotKeys(enabled: enabled, signature: signature));
  }

  void _bindPersistenceProvider() {
    final persistence = context.read<PersistenceProvider>();
    if (identical(_persistenceProvider, persistence)) return;

    _persistenceProvider?.removeListener(_handlePersistenceChanged);
    _persistenceProvider = persistence;
    persistence.addListener(_handlePersistenceChanged);
    _handlePersistenceChanged();
  }

  Future<void> _runBestEffortExitStep(
    String stepName,
    Future<void> Function() action,
  ) async {
    try {
      await action();
    } catch (e, stackTrace) {
      LoggerService.e('[Exit] $stepName failed during exit', e, stackTrace);
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
      await _runBestEffortExitStep('trayManager.destroy', trayManager.destroy);
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

    final bindings = _persistenceProvider == null
        ? AppShortcuts.defaultBindings()
        : AppShortcuts.bindingsFromSettings(_persistenceProvider!.settings);

    for (final command in AppShortcutCommand.values) {
      final hotKey = AppShortcuts.hotKeyFor(command, null, bindings);

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
          'Failed to register ${AppShortcuts.labelFor(command, null, bindings)}',
          e,
          stackTrace,
        );
      }
    }
  }

  Future<void> _syncGlobalHotKeys({
    required bool enabled,
    required String signature,
  }) async {
    if (!_supportsSystemWideHotKeys) return;

    final syncVersion = ++_hotKeySyncVersion;
    _globalHotKeysEnabled = enabled;
    _globalHotKeysSignature = signature;

    await _unregisterGlobalHotKeys();
    if (!enabled || syncVersion != _hotKeySyncVersion) {
      return;
    }

    await _registerGlobalHotKeys();
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
    if (Platform.isMacOS) {
      _lifecycleChannel.setMethodCallHandler(_onLifecycleCall);
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _bindPersistenceProvider();
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
      if (Platform.isMacOS) {
        await trayManager.setIcon(
          'assets/icons/mac_tray_icon_template.png',
          isTemplate: true,
        );
      } else {
        await trayManager.setIcon(
          Platform.isWindows ? 'assets/icons/icon.ico' : 'assets/icons/icon.png',
        );
      }
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
    _persistenceProvider?.removeListener(_handlePersistenceChanged);
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
  void onWindowResized() async {
    final persistence = context.read<PersistenceProvider>();
    if (persistence.settings['rememberWindowSize'] ?? false) {
      final size = await windowManager.getSize();
      await persistence.saveWindowSize(size);
    }
  }

  @override
  void onWindowMoved() async {
    final persistence = context.read<PersistenceProvider>();
    if (persistence.settings['rememberWindowSize'] ?? false) {
      final position = await windowManager.getPosition();
      await persistence.saveWindowPosition(position);
    }
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
