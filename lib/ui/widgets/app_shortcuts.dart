import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:hotkey_manager/hotkey_manager.dart';

enum DesktopShortcutPlatform { macOS, windows, linux }

enum AppShortcutCommand {
  togglePlayback,
  previousTrack,
  nextTrack,
  volumeUp,
  volumeDown,
  toggleMute,
  toggleFavorite,
  togglePlayMode,
}

class AppShortcutInfo {
  const AppShortcutInfo({
    required this.command,
    required this.title,
    required this.description,
  });

  final AppShortcutCommand command;
  final String title;
  final String description;
}

class AppShortcuts extends StatelessWidget {
  const AppShortcuts({
    super.key,
    required this.child,
    this.onTogglePlayback,
    this.onPreviousTrack,
    this.onNextTrack,
    this.onVolumeUp,
    this.onVolumeDown,
    this.onToggleMute,
    this.onToggleFavorite,
    this.onTogglePlayMode,
  });

  final Widget child;
  final FutureOr<void> Function()? onTogglePlayback;
  final FutureOr<void> Function()? onPreviousTrack;
  final FutureOr<void> Function()? onNextTrack;
  final FutureOr<void> Function()? onVolumeUp;
  final FutureOr<void> Function()? onVolumeDown;
  final FutureOr<void> Function()? onToggleMute;
  final FutureOr<void> Function()? onToggleFavorite;
  final FutureOr<void> Function()? onTogglePlayMode;

  static const List<AppShortcutInfo> shortcutInfos = [
    AppShortcutInfo(
      command: AppShortcutCommand.togglePlayback,
      title: '播放 / 暂停',
      description: '切换当前歌曲的播放状态',
    ),
    AppShortcutInfo(
      command: AppShortcutCommand.previousTrack,
      title: '上一首',
      description: '跳转到播放列表中的上一首歌曲',
    ),
    AppShortcutInfo(
      command: AppShortcutCommand.nextTrack,
      title: '下一首',
      description: '跳转到播放列表中的下一首歌曲',
    ),
    AppShortcutInfo(
      command: AppShortcutCommand.volumeUp,
      title: '音量 +',
      description: '将播放器音量提高 5%',
    ),
    AppShortcutInfo(
      command: AppShortcutCommand.volumeDown,
      title: '音量 -',
      description: '将播放器音量降低 5%',
    ),
    AppShortcutInfo(
      command: AppShortcutCommand.toggleMute,
      title: '静音',
      description: '切换播放器静音状态',
    ),
    AppShortcutInfo(
      command: AppShortcutCommand.toggleFavorite,
      title: '收藏当前歌曲',
      description: '切换播放器当前歌曲的收藏状态',
    ),
    AppShortcutInfo(
      command: AppShortcutCommand.togglePlayMode,
      title: '切换播放模式',
      description: '在列表循环、单曲循环、随机播放之间切换',
    ),
  ];

  static DesktopShortcutPlatform get currentPlatform {
    if (Platform.isMacOS) return DesktopShortcutPlatform.macOS;
    if (Platform.isLinux) return DesktopShortcutPlatform.linux;
    return DesktopShortcutPlatform.windows;
  }

  static String labelFor(
    AppShortcutCommand command, [
    DesktopShortcutPlatform? platform,
  ]) {
    final targetPlatform = platform ?? currentPlatform;
    final modifierPrefix = targetPlatform == DesktopShortcutPlatform.macOS
        ? '⌘⇧'
        : 'Ctrl+Shift+';

    switch (command) {
      case AppShortcutCommand.togglePlayback:
        return '${modifierPrefix}Space';
      case AppShortcutCommand.previousTrack:
        return '$modifierPrefix←';
      case AppShortcutCommand.nextTrack:
        return '$modifierPrefix→';
      case AppShortcutCommand.volumeUp:
        return '$modifierPrefix↑';
      case AppShortcutCommand.volumeDown:
        return '$modifierPrefix↓';
      case AppShortcutCommand.toggleMute:
        return '${modifierPrefix}M';
      case AppShortcutCommand.toggleFavorite:
        return '${modifierPrefix}L';
      case AppShortcutCommand.togglePlayMode:
        return '${modifierPrefix}P';
    }
  }

  static HotKey hotKeyFor(
    AppShortcutCommand command, [
    DesktopShortcutPlatform? platform,
  ]) {
    final targetPlatform = platform ?? currentPlatform;
    final modifiers = _systemModifiersFor(targetPlatform);

    switch (command) {
      case AppShortcutCommand.togglePlayback:
        return HotKey(key: PhysicalKeyboardKey.space, modifiers: modifiers);
      case AppShortcutCommand.previousTrack:
        return HotKey(key: PhysicalKeyboardKey.arrowLeft, modifiers: modifiers);
      case AppShortcutCommand.nextTrack:
        return HotKey(
          key: PhysicalKeyboardKey.arrowRight,
          modifiers: modifiers,
        );
      case AppShortcutCommand.volumeUp:
        return HotKey(key: PhysicalKeyboardKey.arrowUp, modifiers: modifiers);
      case AppShortcutCommand.volumeDown:
        return HotKey(key: PhysicalKeyboardKey.arrowDown, modifiers: modifiers);
      case AppShortcutCommand.toggleMute:
        return HotKey(key: PhysicalKeyboardKey.keyM, modifiers: modifiers);
      case AppShortcutCommand.toggleFavorite:
        return HotKey(key: PhysicalKeyboardKey.keyL, modifiers: modifiers);
      case AppShortcutCommand.togglePlayMode:
        return HotKey(key: PhysicalKeyboardKey.keyP, modifiers: modifiers);
    }
  }

  static List<HotKeyModifier> _systemModifiersFor(
    DesktopShortcutPlatform platform,
  ) {
    if (platform == DesktopShortcutPlatform.macOS) {
      return [HotKeyModifier.meta, HotKeyModifier.shift];
    }

    return [HotKeyModifier.control, HotKeyModifier.shift];
  }

  static Map<ShortcutActivator, Intent> shortcutsFor(
    DesktopShortcutPlatform platform,
  ) {
    final shortcuts = <ShortcutActivator, Intent>{
      const SingleActivator(LogicalKeyboardKey.mediaPlayPause):
          const _TogglePlaybackIntent(),
      const SingleActivator(LogicalKeyboardKey.mediaTrackPrevious):
          const _PreviousTrackIntent(),
      const SingleActivator(LogicalKeyboardKey.mediaTrackNext):
          const _NextTrackIntent(),
      const SingleActivator(LogicalKeyboardKey.audioVolumeUp):
          const _VolumeUpIntent(),
      const SingleActivator(LogicalKeyboardKey.audioVolumeDown):
          const _VolumeDownIntent(),
      const SingleActivator(LogicalKeyboardKey.audioVolumeMute):
          const _ToggleMuteIntent(),
    };

    if (platform == DesktopShortcutPlatform.macOS) {
      shortcuts.addAll(const {
        SingleActivator(LogicalKeyboardKey.space, meta: true, shift: true):
            _TogglePlaybackIntent(),
        SingleActivator(LogicalKeyboardKey.arrowLeft, meta: true, shift: true):
            _PreviousTrackIntent(),
        SingleActivator(LogicalKeyboardKey.arrowRight, meta: true, shift: true):
            _NextTrackIntent(),
        SingleActivator(LogicalKeyboardKey.arrowUp, meta: true, shift: true):
            _VolumeUpIntent(),
        SingleActivator(LogicalKeyboardKey.arrowDown, meta: true, shift: true):
            _VolumeDownIntent(),
        SingleActivator(LogicalKeyboardKey.keyM, meta: true, shift: true):
            _ToggleMuteIntent(),
        SingleActivator(LogicalKeyboardKey.keyL, meta: true, shift: true):
            _ToggleFavoriteIntent(),
        SingleActivator(LogicalKeyboardKey.keyP, meta: true, shift: true):
            _TogglePlayModeIntent(),
      });
    } else {
      shortcuts.addAll(const {
        SingleActivator(LogicalKeyboardKey.space, control: true, shift: true):
            _TogglePlaybackIntent(),
        SingleActivator(
          LogicalKeyboardKey.arrowLeft,
          control: true,
          shift: true,
        ): _PreviousTrackIntent(),
        SingleActivator(
          LogicalKeyboardKey.arrowRight,
          control: true,
          shift: true,
        ): _NextTrackIntent(),
        SingleActivator(LogicalKeyboardKey.arrowUp, control: true, shift: true):
            _VolumeUpIntent(),
        SingleActivator(
          LogicalKeyboardKey.arrowDown,
          control: true,
          shift: true,
        ): _VolumeDownIntent(),
        SingleActivator(LogicalKeyboardKey.keyM, control: true, shift: true):
            _ToggleMuteIntent(),
        SingleActivator(LogicalKeyboardKey.keyL, control: true, shift: true):
            _ToggleFavoriteIntent(),
        SingleActivator(LogicalKeyboardKey.keyP, control: true, shift: true):
            _TogglePlayModeIntent(),
      });
    }

    return shortcuts;
  }

  @override
  Widget build(BuildContext context) {
    return Shortcuts(
      shortcuts: shortcutsFor(currentPlatform),
      child: Actions(
        actions: <Type, Action<Intent>>{
          _TogglePlaybackIntent: _buildAction<_TogglePlaybackIntent>(
            onTogglePlayback,
          ),
          _PreviousTrackIntent: _buildAction<_PreviousTrackIntent>(
            onPreviousTrack,
          ),
          _NextTrackIntent: _buildAction<_NextTrackIntent>(onNextTrack),
          _VolumeUpIntent: _buildAction<_VolumeUpIntent>(onVolumeUp),
          _VolumeDownIntent: _buildAction<_VolumeDownIntent>(onVolumeDown),
          _ToggleMuteIntent: _buildAction<_ToggleMuteIntent>(onToggleMute),
          _ToggleFavoriteIntent: _buildAction<_ToggleFavoriteIntent>(
            onToggleFavorite,
          ),
          _TogglePlayModeIntent: _buildAction<_TogglePlayModeIntent>(
            onTogglePlayMode,
          ),
        },
        child: Focus(autofocus: true, child: child),
      ),
    );
  }

  Action<T> _buildAction<T extends Intent>(
    FutureOr<void> Function()? callback, {
    bool allowWhenEditing = false,
  }) {
    return CallbackAction<T>(
      onInvoke: (_) {
        if (callback == null) return null;
        if (!allowWhenEditing && _isEditableTextFocused()) return null;
        callback();
        return null;
      },
    );
  }

  bool _isEditableTextFocused() {
    final focusContext = FocusManager.instance.primaryFocus?.context;
    if (focusContext == null) return false;

    return focusContext.widget is EditableText ||
        focusContext.findAncestorWidgetOfExactType<EditableText>() != null;
  }
}

class _TogglePlaybackIntent extends Intent {
  const _TogglePlaybackIntent();
}

class _PreviousTrackIntent extends Intent {
  const _PreviousTrackIntent();
}

class _NextTrackIntent extends Intent {
  const _NextTrackIntent();
}

class _VolumeUpIntent extends Intent {
  const _VolumeUpIntent();
}

class _VolumeDownIntent extends Intent {
  const _VolumeDownIntent();
}

class _ToggleMuteIntent extends Intent {
  const _ToggleMuteIntent();
}

class _ToggleFavoriteIntent extends Intent {
  const _ToggleFavoriteIntent();
}

class _TogglePlayModeIntent extends Intent {
  const _TogglePlayModeIntent();
}
