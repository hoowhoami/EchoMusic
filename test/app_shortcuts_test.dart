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

    test('builds expected shortcut activators for each desktop platform', () {
      final macos = AppShortcuts.shortcutsFor(DesktopShortcutPlatform.macOS);
      final windows = AppShortcuts.shortcutsFor(
        DesktopShortcutPlatform.windows,
      );
      final linux = AppShortcuts.shortcutsFor(DesktopShortcutPlatform.linux);

      expect(
        macos.containsKey(
          const SingleActivator(
            LogicalKeyboardKey.space,
            meta: true,
            shift: true,
          ),
        ),
        isTrue,
      );
      expect(
        windows.containsKey(
          const SingleActivator(
            LogicalKeyboardKey.space,
            control: true,
            shift: true,
          ),
        ),
        isTrue,
      );
      expect(
        macos.containsKey(
          const SingleActivator(
            LogicalKeyboardKey.arrowUp,
            meta: true,
            shift: true,
          ),
        ),
        isTrue,
      );
      expect(
        macos.containsKey(
          const SingleActivator(
            LogicalKeyboardKey.keyL,
            meta: true,
            shift: true,
          ),
        ),
        isTrue,
      );
      expect(
        windows.containsKey(
          const SingleActivator(
            LogicalKeyboardKey.arrowDown,
            control: true,
            shift: true,
          ),
        ),
        isTrue,
      );
      expect(
        linux.containsKey(
          const SingleActivator(
            LogicalKeyboardKey.keyP,
            control: true,
            shift: true,
          ),
        ),
        isTrue,
      );
      expect(
        macos.containsKey(
          const SingleActivator(LogicalKeyboardKey.audioVolumeUp),
        ),
        isTrue,
      );
      expect(
        windows.containsKey(
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
