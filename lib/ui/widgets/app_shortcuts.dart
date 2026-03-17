import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:hotkey_manager/hotkey_manager.dart';

enum DesktopShortcutPlatform { macOS, windows, linux }

class AppShortcutBinding {
  const AppShortcutBinding({
    required this.physicalKey,
    required this.logicalKey,
    this.control = false,
    this.shift = false,
    this.alt = false,
    this.meta = false,
  });

  factory AppShortcutBinding.withPlatformModifiers({
    required PhysicalKeyboardKey physicalKey,
    required LogicalKeyboardKey logicalKey,
    DesktopShortcutPlatform? platform,
  }) {
    final targetPlatform = platform ?? AppShortcuts.currentPlatform;
    return AppShortcutBinding(
      physicalKey: physicalKey,
      logicalKey: logicalKey,
      control: targetPlatform != DesktopShortcutPlatform.macOS,
      shift: true,
      meta: targetPlatform == DesktopShortcutPlatform.macOS,
    );
  }

  final PhysicalKeyboardKey physicalKey;
  final LogicalKeyboardKey logicalKey;
  final bool control;
  final bool shift;
  final bool alt;
  final bool meta;

  HotKey toHotKey() {
    return HotKey(
      key: physicalKey,
      modifiers: [
        if (meta) HotKeyModifier.meta,
        if (control) HotKeyModifier.control,
        if (alt) HotKeyModifier.alt,
        if (shift) HotKeyModifier.shift,
      ],
    );
  }

  SingleActivator toActivator() {
    return SingleActivator(
      logicalKey,
      control: control,
      shift: shift,
      alt: alt,
      meta: meta,
    );
  }

  String label([DesktopShortcutPlatform? platform]) {
    final targetPlatform = platform ?? AppShortcuts.currentPlatform;
    final keyLabel = AppShortcuts.keyLabel(logicalKey);

    if (targetPlatform == DesktopShortcutPlatform.macOS) {
      return [
        if (meta) '⌘',
        if (control) '⌃',
        if (alt) '⌥',
        if (shift) '⇧',
        keyLabel,
      ].join();
    }

    return [
      if (control) 'Ctrl',
      if (alt) 'Alt',
      if (shift) 'Shift',
      if (meta) 'Meta',
      keyLabel,
    ].join('+');
  }

  Map<String, dynamic> toJson() {
    return {
      'physicalKey': physicalKey.usbHidUsage,
      'logicalKey': logicalKey.keyId,
      'control': control,
      'shift': shift,
      'alt': alt,
      'meta': meta,
    };
  }

  static AppShortcutBinding? fromJson(dynamic json) {
    if (json is! Map) return null;

    final physicalCode = _toInt(json['physicalKey']);
    final logicalId = _toInt(json['logicalKey']);
    if (physicalCode == null || logicalId == null) return null;

    return AppShortcutBinding(
      physicalKey:
          PhysicalKeyboardKey.findKeyByCode(physicalCode) ??
          PhysicalKeyboardKey(physicalCode),
      logicalKey:
          LogicalKeyboardKey.findKeyByKeyId(logicalId) ??
          LogicalKeyboardKey(logicalId),
      control: json['control'] == true,
      shift: json['shift'] == true,
      alt: json['alt'] == true,
      meta: json['meta'] == true,
    );
  }

  static int? _toInt(dynamic value) {
    if (value is int) return value;
    if (value is num) return value.toInt();
    if (value is String) return int.tryParse(value);
    return null;
  }

  @override
  bool operator ==(Object other) {
    return other is AppShortcutBinding &&
        other.physicalKey == physicalKey &&
        other.logicalKey == logicalKey &&
        other.control == control &&
        other.shift == shift &&
        other.alt == alt &&
        other.meta == meta;
  }

  @override
  int get hashCode =>
      Object.hash(physicalKey, logicalKey, control, shift, alt, meta);
}

enum AppShortcutCommand {
  togglePlayback,
  previousTrack,
  nextTrack,
  volumeUp,
  volumeDown,
  toggleMute,
  toggleFavorite,
  togglePlayMode,
  toggleWindow,
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
    this.enabled = true,
    this.bindings,
    this.onTogglePlayback,
    this.onPreviousTrack,
    this.onNextTrack,
    this.onVolumeUp,
    this.onVolumeDown,
    this.onToggleMute,
    this.onToggleFavorite,
    this.onTogglePlayMode,
    this.onToggleWindow,
  });

  final Widget child;
  final bool enabled;
  final Map<AppShortcutCommand, AppShortcutBinding>? bindings;
  final FutureOr<void> Function()? onTogglePlayback;
  final FutureOr<void> Function()? onPreviousTrack;
  final FutureOr<void> Function()? onNextTrack;
  final FutureOr<void> Function()? onVolumeUp;
  final FutureOr<void> Function()? onVolumeDown;
  final FutureOr<void> Function()? onToggleMute;
  final FutureOr<void> Function()? onToggleFavorite;
  final FutureOr<void> Function()? onTogglePlayMode;
  final FutureOr<void> Function()? onToggleWindow;

  static const String bindingsSettingKey = 'globalShortcutBindings';

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
    AppShortcutInfo(
      command: AppShortcutCommand.toggleWindow,
      title: '显示 / 隐藏窗口',
      description: '切换主窗口的显示和隐藏状态',
    ),
  ];

  static DesktopShortcutPlatform get currentPlatform {
    if (Platform.isMacOS) return DesktopShortcutPlatform.macOS;
    if (Platform.isLinux) return DesktopShortcutPlatform.linux;
    return DesktopShortcutPlatform.windows;
  }

  static AppShortcutBinding defaultBindingFor(
    AppShortcutCommand command, [
    DesktopShortcutPlatform? platform,
  ]) {
    final targetPlatform = platform ?? currentPlatform;

    switch (command) {
      case AppShortcutCommand.togglePlayback:
        return AppShortcutBinding.withPlatformModifiers(
          physicalKey: PhysicalKeyboardKey.space,
          logicalKey: LogicalKeyboardKey.space,
          platform: targetPlatform,
        );
      case AppShortcutCommand.previousTrack:
        return AppShortcutBinding.withPlatformModifiers(
          physicalKey: PhysicalKeyboardKey.arrowLeft,
          logicalKey: LogicalKeyboardKey.arrowLeft,
          platform: targetPlatform,
        );
      case AppShortcutCommand.nextTrack:
        return AppShortcutBinding.withPlatformModifiers(
          physicalKey: PhysicalKeyboardKey.arrowRight,
          logicalKey: LogicalKeyboardKey.arrowRight,
          platform: targetPlatform,
        );
      case AppShortcutCommand.volumeUp:
        return AppShortcutBinding.withPlatformModifiers(
          physicalKey: PhysicalKeyboardKey.arrowUp,
          logicalKey: LogicalKeyboardKey.arrowUp,
          platform: targetPlatform,
        );
      case AppShortcutCommand.volumeDown:
        return AppShortcutBinding.withPlatformModifiers(
          physicalKey: PhysicalKeyboardKey.arrowDown,
          logicalKey: LogicalKeyboardKey.arrowDown,
          platform: targetPlatform,
        );
      case AppShortcutCommand.toggleMute:
        return AppShortcutBinding.withPlatformModifiers(
          physicalKey: PhysicalKeyboardKey.keyM,
          logicalKey: LogicalKeyboardKey.keyM,
          platform: targetPlatform,
        );
      case AppShortcutCommand.toggleFavorite:
        return AppShortcutBinding.withPlatformModifiers(
          physicalKey: PhysicalKeyboardKey.keyL,
          logicalKey: LogicalKeyboardKey.keyL,
          platform: targetPlatform,
        );
      case AppShortcutCommand.togglePlayMode:
        return AppShortcutBinding.withPlatformModifiers(
          physicalKey: PhysicalKeyboardKey.keyP,
          logicalKey: LogicalKeyboardKey.keyP,
          platform: targetPlatform,
        );
      case AppShortcutCommand.toggleWindow:
        return AppShortcutBinding.withPlatformModifiers(
          physicalKey: PhysicalKeyboardKey.keyW,
          logicalKey: LogicalKeyboardKey.keyW,
          platform: targetPlatform,
        );
    }
  }

  static Map<AppShortcutCommand, AppShortcutBinding> defaultBindings([
    DesktopShortcutPlatform? platform,
  ]) {
    final targetPlatform = platform ?? currentPlatform;
    return {
      for (final command in AppShortcutCommand.values)
        command: defaultBindingFor(command, targetPlatform),
    };
  }

  static Map<AppShortcutCommand, AppShortcutBinding> bindingsFromSettings(
    Map<String, dynamic> settings, [
    DesktopShortcutPlatform? platform,
  ]) {
    final targetPlatform = platform ?? currentPlatform;
    final resolved = defaultBindings(targetPlatform);
    final rawBindings = settings[bindingsSettingKey];
    if (rawBindings is! Map) return resolved;

    for (final entry in rawBindings.entries) {
      final command = _commandFromName(entry.key.toString());
      final binding = AppShortcutBinding.fromJson(entry.value);
      if (command != null && binding != null) {
        resolved[command] = binding;
      }
    }

    return resolved;
  }

  static Map<String, dynamic> serializeBindings(
    Map<AppShortcutCommand, AppShortcutBinding> bindings,
  ) {
    return {
      for (final entry in bindings.entries)
        entry.key.name: entry.value.toJson(),
    };
  }

  static AppShortcutBinding bindingFor(
    AppShortcutCommand command, [
    DesktopShortcutPlatform? platform,
    Map<AppShortcutCommand, AppShortcutBinding>? bindings,
  ]) {
    final targetPlatform = platform ?? currentPlatform;
    return bindings?[command] ?? defaultBindingFor(command, targetPlatform);
  }

  static String labelFor(
    AppShortcutCommand command, [
    DesktopShortcutPlatform? platform,
    Map<AppShortcutCommand, AppShortcutBinding>? bindings,
  ]) {
    final targetPlatform = platform ?? currentPlatform;
    return bindingFor(command, targetPlatform, bindings).label(targetPlatform);
  }

  static String labelForSettings(
    AppShortcutCommand command,
    Map<String, dynamic> settings, [
    DesktopShortcutPlatform? platform,
  ]) {
    final targetPlatform = platform ?? currentPlatform;
    final resolvedBindings = bindingsFromSettings(settings, targetPlatform);
    return labelFor(command, targetPlatform, resolvedBindings);
  }

  static HotKey hotKeyFor(
    AppShortcutCommand command, [
    DesktopShortcutPlatform? platform,
    Map<AppShortcutCommand, AppShortcutBinding>? bindings,
  ]) {
    final targetPlatform = platform ?? currentPlatform;
    return bindingFor(command, targetPlatform, bindings).toHotKey();
  }

  static AppShortcutBinding? bindingFromKeyEvent(
    KeyEvent event, [
    DesktopShortcutPlatform? platform,
  ]) {
    if (_isModifierKey(event.logicalKey)) return null;
    return AppShortcutBinding.withPlatformModifiers(
      physicalKey: event.physicalKey,
      logicalKey: event.logicalKey,
      platform: platform,
    );
  }

  static String platformModifierLabel([DesktopShortcutPlatform? platform]) {
    final targetPlatform = platform ?? currentPlatform;
    return targetPlatform == DesktopShortcutPlatform.macOS
        ? '⌘⇧'
        : 'Ctrl+Shift+';
  }

  static String keyLabel(LogicalKeyboardKey key) {
    if (key == LogicalKeyboardKey.arrowLeft) return '←';
    if (key == LogicalKeyboardKey.arrowRight) return '→';
    if (key == LogicalKeyboardKey.arrowUp) return '↑';
    if (key == LogicalKeyboardKey.arrowDown) return '↓';
    if (key == LogicalKeyboardKey.space) return 'Space';
    if (key == LogicalKeyboardKey.escape) return 'Esc';

    final keyLabel = key.keyLabel;
    if (keyLabel.isNotEmpty) {
      return keyLabel.length == 1 ? keyLabel.toUpperCase() : keyLabel;
    }

    final debugName = key.debugName;
    if (debugName == null || debugName.isEmpty) return 'Unknown';
    return debugName.replaceFirst('Key ', '');
  }

  static bool isDefaultBinding(
    AppShortcutCommand command,
    AppShortcutBinding binding, [
    DesktopShortcutPlatform? platform,
  ]) {
    return binding == defaultBindingFor(command, platform);
  }

  static AppShortcutCommand? _commandFromName(String name) {
    for (final command in AppShortcutCommand.values) {
      if (command.name == name) return command;
    }
    return null;
  }

  static bool _isModifierKey(LogicalKeyboardKey key) {
    return key == LogicalKeyboardKey.shift ||
        key == LogicalKeyboardKey.shiftLeft ||
        key == LogicalKeyboardKey.shiftRight ||
        key == LogicalKeyboardKey.control ||
        key == LogicalKeyboardKey.controlLeft ||
        key == LogicalKeyboardKey.controlRight ||
        key == LogicalKeyboardKey.alt ||
        key == LogicalKeyboardKey.altLeft ||
        key == LogicalKeyboardKey.altRight ||
        key == LogicalKeyboardKey.meta ||
        key == LogicalKeyboardKey.metaLeft ||
        key == LogicalKeyboardKey.metaRight;
  }

  static Intent _intentForCommand(AppShortcutCommand command) {
    switch (command) {
      case AppShortcutCommand.togglePlayback:
        return const _TogglePlaybackIntent();
      case AppShortcutCommand.previousTrack:
        return const _PreviousTrackIntent();
      case AppShortcutCommand.nextTrack:
        return const _NextTrackIntent();
      case AppShortcutCommand.volumeUp:
        return const _VolumeUpIntent();
      case AppShortcutCommand.volumeDown:
        return const _VolumeDownIntent();
      case AppShortcutCommand.toggleMute:
        return const _ToggleMuteIntent();
      case AppShortcutCommand.toggleFavorite:
        return const _ToggleFavoriteIntent();
      case AppShortcutCommand.togglePlayMode:
        return const _TogglePlayModeIntent();
      case AppShortcutCommand.toggleWindow:
        return const _ToggleWindowIntent();
    }
  }

  static Map<ShortcutActivator, Intent> shortcutsFor(
    DesktopShortcutPlatform platform, [
    Map<AppShortcutCommand, AppShortcutBinding>? bindings,
  ]) {
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

    for (final command in AppShortcutCommand.values) {
      shortcuts[bindingFor(command, platform, bindings).toActivator()] =
          _intentForCommand(command);
    }

    return shortcuts;
  }

  @override
  Widget build(BuildContext context) {
    if (!enabled) {
      return child;
    }

    return Shortcuts(
      shortcuts: shortcutsFor(currentPlatform, bindings),
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
          _ToggleWindowIntent: _buildAction<_ToggleWindowIntent>(
            onToggleWindow,
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

class _ToggleWindowIntent extends Intent {
  const _ToggleWindowIntent();
}
