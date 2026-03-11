import 'package:echomusic/ui/widgets/app_shortcuts.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hotkey_manager/hotkey_manager.dart';

Future<void> _sendCurrentPlatformShortcut(
  WidgetTester tester,
  LogicalKeyboardKey key,
) async {
  if (AppShortcuts.currentPlatform == DesktopShortcutPlatform.macOS) {
    await tester.sendKeyDownEvent(LogicalKeyboardKey.metaLeft);
    await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
    await tester.sendKeyEvent(key);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.metaLeft);
    return;
  }

  await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
  await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
  await tester.sendKeyEvent(key);
  await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
  await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  final customBinding = AppShortcutBinding.withPlatformModifiers(
    physicalKey: PhysicalKeyboardKey.keyK,
    logicalKey: LogicalKeyboardKey.keyK,
    platform: AppShortcuts.currentPlatform,
  );

  group('AppShortcuts', () {
    test('provides expected platform-specific labels', () {
      expect(
        AppShortcuts.labelFor(
          AppShortcutCommand.togglePlayback,
          DesktopShortcutPlatform.macOS,
        ),
        '⌘⇧Space',
      );
      expect(
        AppShortcuts.labelFor(
          AppShortcutCommand.volumeUp,
          DesktopShortcutPlatform.windows,
        ),
        'Ctrl+Shift+↑',
      );
      expect(
        AppShortcuts.labelFor(
          AppShortcutCommand.toggleFavorite,
          DesktopShortcutPlatform.linux,
        ),
        'Ctrl+Shift+L',
      );
      expect(
        AppShortcuts.labelFor(
          AppShortcutCommand.toggleMute,
          DesktopShortcutPlatform.macOS,
        ),
        '⌘⇧M',
      );
    });

    test('builds expected system hotkeys for each desktop platform', () {
      final macosPlaybackHotKey = AppShortcuts.hotKeyFor(
        AppShortcutCommand.togglePlayback,
        DesktopShortcutPlatform.macOS,
      );
      final windowsFavoriteHotKey = AppShortcuts.hotKeyFor(
        AppShortcutCommand.toggleFavorite,
        DesktopShortcutPlatform.windows,
      );
      final linuxPlayModeHotKey = AppShortcuts.hotKeyFor(
        AppShortcutCommand.togglePlayMode,
        DesktopShortcutPlatform.linux,
      );

      expect(macosPlaybackHotKey.scope, HotKeyScope.system);
      expect(macosPlaybackHotKey.physicalKey, PhysicalKeyboardKey.space);
      expect(
        macosPlaybackHotKey.modifiers,
        orderedEquals([HotKeyModifier.meta, HotKeyModifier.shift]),
      );

      expect(windowsFavoriteHotKey.physicalKey, PhysicalKeyboardKey.keyL);
      expect(
        windowsFavoriteHotKey.modifiers,
        orderedEquals([HotKeyModifier.control, HotKeyModifier.shift]),
      );

      expect(linuxPlayModeHotKey.physicalKey, PhysicalKeyboardKey.keyP);
      expect(
        linuxPlayModeHotKey.modifiers,
        orderedEquals([HotKeyModifier.control, HotKeyModifier.shift]),
      );
    });

    test('supports custom bindings from settings', () {
      final settings = {
        AppShortcuts.bindingsSettingKey: {
          AppShortcutCommand.togglePlayback.name: customBinding.toJson(),
        },
      };

      final bindings = AppShortcuts.bindingsFromSettings(settings);

      expect(
        AppShortcuts.labelFor(
          AppShortcutCommand.togglePlayback,
          AppShortcuts.currentPlatform,
          bindings,
        ),
        AppShortcuts.currentPlatform == DesktopShortcutPlatform.macOS
            ? '⌘⇧K'
            : 'Ctrl+Shift+K',
      );
      expect(
        AppShortcuts.hotKeyFor(
          AppShortcutCommand.togglePlayback,
          AppShortcuts.currentPlatform,
          bindings,
        ).physicalKey,
        PhysicalKeyboardKey.keyK,
      );

      final activator = AppShortcuts.bindingFor(
        AppShortcutCommand.togglePlayback,
        AppShortcuts.currentPlatform,
        bindings,
      ).toActivator();

      expect(activator.trigger, LogicalKeyboardKey.keyK);
      expect(activator.shift, isTrue);
      expect(
        activator.meta,
        AppShortcuts.currentPlatform == DesktopShortcutPlatform.macOS,
      );
      expect(
        activator.control,
        AppShortcuts.currentPlatform != DesktopShortcutPlatform.macOS,
      );
    });

    test('builds expected shortcut activators for each desktop platform', () {
      final macosPlayback = AppShortcuts.bindingFor(
        AppShortcutCommand.togglePlayback,
        DesktopShortcutPlatform.macOS,
      ).toActivator();
      final macosFavorite = AppShortcuts.bindingFor(
        AppShortcutCommand.toggleFavorite,
        DesktopShortcutPlatform.macOS,
      ).toActivator();
      final windowsPlayback = AppShortcuts.bindingFor(
        AppShortcutCommand.togglePlayback,
        DesktopShortcutPlatform.windows,
      ).toActivator();
      final windowsVolumeDown = AppShortcuts.bindingFor(
        AppShortcutCommand.volumeDown,
        DesktopShortcutPlatform.windows,
      ).toActivator();
      final linuxPlayMode = AppShortcuts.bindingFor(
        AppShortcutCommand.togglePlayMode,
        DesktopShortcutPlatform.linux,
      ).toActivator();
      final mediaShortcuts = AppShortcuts.shortcutsFor(
        DesktopShortcutPlatform.macOS,
      );

      expect(macosPlayback.trigger, LogicalKeyboardKey.space);
      expect(macosPlayback.meta, isTrue);
      expect(macosPlayback.shift, isTrue);
      expect(macosPlayback.control, isFalse);

      expect(macosFavorite.trigger, LogicalKeyboardKey.keyL);
      expect(macosFavorite.meta, isTrue);
      expect(macosFavorite.shift, isTrue);

      expect(windowsPlayback.trigger, LogicalKeyboardKey.space);
      expect(windowsPlayback.control, isTrue);
      expect(windowsPlayback.shift, isTrue);
      expect(windowsPlayback.meta, isFalse);

      expect(windowsVolumeDown.trigger, LogicalKeyboardKey.arrowDown);
      expect(windowsVolumeDown.control, isTrue);
      expect(windowsVolumeDown.shift, isTrue);

      expect(linuxPlayMode.trigger, LogicalKeyboardKey.keyP);
      expect(linuxPlayMode.control, isTrue);
      expect(linuxPlayMode.shift, isTrue);

      expect(
        mediaShortcuts.containsKey(
          const SingleActivator(LogicalKeyboardKey.audioVolumeUp),
        ),
        isTrue,
      );
      expect(
        mediaShortcuts.containsKey(
          const SingleActivator(LogicalKeyboardKey.audioVolumeMute),
        ),
        isTrue,
      );
    });

    testWidgets('prevents playback shortcuts while editing text', (
      tester,
    ) async {
      var toggled = 0;

      await tester.pumpWidget(
        MaterialApp(
          home: AppShortcuts(
            onTogglePlayback: () => toggled++,
            child: const Scaffold(body: TextField()),
          ),
        ),
      );
      await tester.pump();

      await tester.tap(find.byType(TextField));
      await tester.pump();

      await tester.sendKeyEvent(LogicalKeyboardKey.space);
      await tester.pump();

      await _sendCurrentPlatformShortcut(tester, LogicalKeyboardKey.space);
      await tester.pump();

      expect(toggled, 0);
    });

    testWidgets('triggers play mode shortcut on current platform', (
      tester,
    ) async {
      var toggled = 0;

      await tester.pumpWidget(
        MaterialApp(
          home: AppShortcuts(
            onTogglePlayMode: () => toggled++,
            child: const Scaffold(body: SizedBox.expand()),
          ),
        ),
      );
      await tester.pump();

      await _sendCurrentPlatformShortcut(tester, LogicalKeyboardKey.keyP);
      await tester.pump();

      expect(toggled, 1);
    });

    testWidgets('triggers custom shortcut binding on current platform', (
      tester,
    ) async {
      var toggled = 0;

      await tester.pumpWidget(
        MaterialApp(
          home: AppShortcuts(
            bindings: {AppShortcutCommand.togglePlayback: customBinding},
            onTogglePlayback: () => toggled++,
            child: const Scaffold(body: SizedBox.expand()),
          ),
        ),
      );
      await tester.pump();

      await _sendCurrentPlatformShortcut(tester, LogicalKeyboardKey.keyK);
      await tester.pump();

      expect(toggled, 1);
    });

    testWidgets('does not trigger shortcuts when disabled', (tester) async {
      var toggled = 0;

      await tester.pumpWidget(
        MaterialApp(
          home: AppShortcuts(
            enabled: false,
            onTogglePlayback: () => toggled++,
            child: const Scaffold(body: SizedBox.expand()),
          ),
        ),
      );
      await tester.pump();

      await _sendCurrentPlatformShortcut(tester, LogicalKeyboardKey.space);
      await tester.pump();

      expect(toggled, 0);
    });

    testWidgets(
      'prevents favorite shortcut while editing text on current platform',
      (tester) async {
        var toggled = 0;

        await tester.pumpWidget(
          MaterialApp(
            home: AppShortcuts(
              onToggleFavorite: () => toggled++,
              child: const Scaffold(body: TextField()),
            ),
          ),
        );
        await tester.pump();

        await tester.tap(find.byType(TextField));
        await tester.pump();

        await _sendCurrentPlatformShortcut(tester, LogicalKeyboardKey.keyL);
        await tester.pump();

        expect(toggled, 0);
      },
    );
  });
}
