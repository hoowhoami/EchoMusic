import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:media_kit/media_kit.dart';
import '../../providers/persistence_provider.dart';
import '../../providers/audio_provider.dart';
import '../../utils/constants.dart';
import '../../utils/version_service.dart';
import '../../utils/logger.dart';
import '../widgets/scrollable_content.dart';
import '../widgets/custom_dialog.dart';
import '../widgets/disclaimer_dialog.dart';
import '../widgets/update_dialog.dart';
import '../widgets/custom_toast.dart';
import '../widgets/app_shortcuts.dart';
import 'package:url_launcher/url_launcher.dart';
import 'dart:io';

class SettingView extends StatefulWidget {
  const SettingView({super.key});

  @override
  State<SettingView> createState() => _SettingViewState();
}

class _SettingViewState extends State<SettingView> {
  String _currentVersion = '1.0.0';

  @override
  void initState() {
    super.initState();
    _loadVersion();
  }

  Future<void> _loadVersion() async {
    final packageInfo = await PackageInfo.fromPlatform();
    if (mounted) {
      setState(() {
        _currentVersion = packageInfo.version;
      });
    }
  }

  Future<void> _checkForUpdates() async {
    final updateInfo = await VersionService.checkForUpdates();

    if (mounted) {
      if (updateInfo != null && updateInfo.hasUpdate) {
        showDialog(
          context: context,
          builder: (context) => UpdateDialog(
            version: updateInfo.version,
            releaseNotes: updateInfo.releaseNotes,
          ),
        );
      } else {
        showDialog(
          context: context,
          builder: (context) =>
              UpdateDialog(version: _currentVersion, isLatest: true),
        );
      }
    }
  }

  Future<void> _exportLogs() async {
    final logFile = LoggerService.logFile;
    if (logFile == null) {
      if (mounted) {
        CustomToast.info(context, '当前处于开发模式，日志仅在控制台输出');
      }
      return;
    }

    final logDir = logFile.parent;
    if (!await logDir.exists()) {
      if (mounted) {
        CustomToast.error(context, '日志目录不存在');
      }
      return;
    }

    try {
      await _openDirectory(logDir.path);
      if (mounted) {
        CustomToast.success(context, '已打开日志目录');
      }
    } catch (e) {
      if (mounted) {
        CustomToast.error(context, '无法打开日志目录: $e');
      }
    }
  }

  Future<void> _openDirectory(String path) async {
    final List<List<String>> commands = Platform.isMacOS
        ? const [
            ['open'],
          ]
        : Platform.isWindows
        ? const [
            ['explorer.exe'],
          ]
        : const [
            ['xdg-open'],
            ['gio', 'open'],
          ];

    Object? lastError;
    for (final command in commands) {
      try {
        final executable = command.first;
        final arguments = [...command.skip(1), path];
        final result = await Process.run(executable, arguments);
        if (result.exitCode == 0) {
          return;
        }

        final stderr = result.stderr?.toString().trim();
        lastError = stderr != null && stderr.isNotEmpty
            ? stderr
            : 'exit code ${result.exitCode}';
      } catch (e) {
        lastError = e;
      }
    }

    throw Exception(lastError ?? '未找到可用的目录打开方式');
  }

  @override
  Widget build(BuildContext context) {
    final persistence = context.watch<PersistenceProvider>();
    final settings = persistence.settings;
    final audio = context.watch<AudioProvider>();
    final theme = Theme.of(context);
    final accentColor = theme.colorScheme.primary;

    return ScrollableContent(
      padding: const EdgeInsets.symmetric(horizontal: 40, vertical: 40),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _buildHeader(context),
          const SizedBox(height: 40),

          _buildGroup(context, '外观与界面', CupertinoIcons.paintbrush, [
            _buildItem(
              context,
              '主题模式',
              '选择您喜欢的主题外观',
              trailing: _buildDropdown(
                context,
                ['跟随系统', '浅色模式', '深色模式'],
                _themeToLabel(settings['theme']),
                (label) {
                  persistence.updateSetting('theme', _labelToTheme(label));
                },
              ),
            ),
            _buildItem(
              context,
              '播放列表计数',
              '在播放器的播放列表图标上显示计数',
              trailing: _buildSwitch(
                context,
                settings['showPlaylistCount'] ?? true,
                (v) => persistence.updateSetting('showPlaylistCount', v),
              ),
            ),
            _buildItem(
              context,
              '关闭行为',
              '点击窗口关闭按钮时的应用程序行为',
              trailing: _buildDropdown(
                context,
                ['最小化到托盘', '彻底退出程序'],
                settings['closeBehavior'] == 'exit' ? '彻底退出程序' : '最小化到托盘',
                (label) {
                  persistence.updateSetting(
                    'closeBehavior',
                    label == '彻底退出程序' ? 'exit' : 'tray',
                  );
                },
              ),
            ),
          ]),

          const SizedBox(height: 32),
          _buildGroup(context, '播放体验', CupertinoIcons.play_circle, [
            _buildItem(
              context,
              '播放替换队列',
              '在歌单/专辑/歌手列表中，双击播放单曲时，用当前单曲所在的歌曲列表替换播放列表',
              trailing: _buildSwitch(
                context,
                settings['replacePlaylist'] ?? false,
                (v) => persistence.updateSetting('replacePlaylist', v),
              ),
            ),
            _buildItem(
              context,
              '音量淡入淡出',
              '启用播放状态切换时的过渡效果',
              trailing: _buildSwitch(
                context,
                settings['volumeFade'] ?? true,
                (v) => persistence.updateSetting('volumeFade', v),
              ),
            ),
            if (settings['volumeFade'] ?? true)
              _buildSliderItem(
                context,
                '淡入淡出时长',
                '${((settings['volumeFadeTime'] ?? 1000) / 1000).toStringAsFixed(1)}s',
                (settings['volumeFadeTime'] ?? 1000).toDouble(),
                100,
                3000,
                (v) => persistence.updateSetting('volumeFadeTime', v.toInt()),
              ),
            _buildItem(
              context,
              '自动跳过错误',
              '歌曲加载失败时自动尝试下一首',
              trailing: _buildSwitch(
                context,
                settings['autoNext'] ?? false,
                (v) => persistence.updateSetting('autoNext', v),
              ),
            ),
            _buildItem(
              context,
              '防止系统休眠',
              '仅在播放音乐时阻止系统进入睡眠状态',
              trailing: _buildSwitch(
                context,
                settings['preventSleep'] ?? true,
                (v) => persistence.updateSetting('preventSleep', v),
              ),
            ),
          ]),

          const SizedBox(height: 32),
          _buildGroup(context, '播放音质', CupertinoIcons.waveform_circle, [
            _buildItem(
              context,
              '首选音质',
              '根据网络环境选择播放音质',
              trailing: _buildDropdown(
                context,
                AudioQuality.options.map((o) => o.label).toList(),
                AudioQuality.getLabel(
                  AudioQuality.normalize(settings['audioQuality']?.toString()),
                ),
                (label) {
                  final value = AudioQuality.options
                      .firstWhere((o) => o.label == label)
                      .value;
                  persistence.updateSetting('audioQuality', value);
                },
              ),
            ),
            _buildItem(
              context,
              '智能兼容模式',
              '首选音质不可用时自动尝试备选',
              trailing: _buildSwitch(
                context,
                settings['compatibilityMode'] ?? true,
                (v) => persistence.updateSetting('compatibilityMode', v),
              ),
            ),
          ]),

          const SizedBox(height: 32),
          _buildGroup(
            context,
            '全局快捷键',
            CupertinoIcons.command,
            AppShortcuts.shortcutInfos
                .map((info) => _buildShortcutItem(context, info))
                .toList(),
          ),

          const SizedBox(height: 32),
          _buildGroup(context, '音频设备', CupertinoIcons.speaker_2, [
            _buildAudioDeviceItem(context, audio),
            _buildItem(
              context,
              '设备断开时暂停',
              Platform.isMacOS
                  ? '在 macOS 上由系统自动处理，此功能不适用'
                  : '检测到音频输出设备断开连接时自动暂停播放',
              trailing: _buildSwitch(
                context,
                Platform.isMacOS
                    ? false
                    : (settings['pauseOnDeviceChange'] ?? false),
                Platform.isMacOS
                    ? null
                    : (v) =>
                          persistence.updateSetting('pauseOnDeviceChange', v),
              ),
            ),
          ]),

          const SizedBox(height: 32),
          _buildGroup(context, '实验性功能', CupertinoIcons.lab_flask, [
            _buildItem(
              context,
              '自动领取 VIP',
              '每次启动时自动领取每日 VIP (需要先登录账号)',
              trailing: _buildSwitch(
                context,
                settings['autoReceiveVip'] ?? false,
                (v) => persistence.updateSetting('autoReceiveVip', v),
              ),
            ),
          ]),

          const SizedBox(height: 32),
          _buildGroup(context, '数据与安全', CupertinoIcons.shield, [
            _buildItem(
              context,
              '导出运行日志',
              '打包当前应用日志以供排查问题',
              trailing: CupertinoButton(
                padding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 8,
                ),
                color: theme.colorScheme.primary.withAlpha(20),
                borderRadius: BorderRadius.circular(10),
                onPressed: _exportLogs,
                child: Text(
                  '立即导出',
                  style: TextStyle(
                    color: theme.colorScheme.primary,
                    fontSize: 13,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
            ),
            _buildItem(
              context,
              '清除应用数据',
              '移除所有持久化设置及缓存信息',
              trailing: CupertinoButton(
                padding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 8,
                ),
                color: theme.colorScheme.error.withAlpha(20),
                borderRadius: BorderRadius.circular(10),
                onPressed: () => _showClearDataDialog(context, persistence),
                child: Text(
                  '立即清除',
                  style: TextStyle(
                    color: theme.colorScheme.error,
                    fontSize: 13,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
            ),
          ]),

          const SizedBox(height: 32),
          _buildGroup(context, '关于 EchoMusic', CupertinoIcons.info_circle, [
            _buildItem(
              context,
              '当前版本',
              'Version v$_currentVersion Stable',
              trailing: MouseRegion(
                cursor: SystemMouseCursors.click,
                child: GestureDetector(
                  onTap: _checkForUpdates,
                  child: Text(
                    '检查更新',
                    style: TextStyle(
                      color: accentColor,
                      fontSize: 13,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                ),
              ),
            ),
            _buildItem(
              context,
              '项目源码',
              '开源共享于 GitHub',
              trailing: MouseRegion(
                cursor: SystemMouseCursors.click,
                child: GestureDetector(
                  onTap: () async {
                    final url = Uri.parse(
                      'https://github.com/hoowhoami/EchoMusic',
                    );
                    if (await canLaunchUrl(url)) {
                      await launchUrl(url);
                    }
                  },
                  child: Icon(
                    CupertinoIcons.arrow_up_right_circle,
                    size: 20,
                    color: theme.colorScheme.onSurfaceVariant.withAlpha(100),
                  ),
                ),
              ),
            ),
            _buildItem(
              context,
              '免责声明',
              '查看法律条款与免责声明',
              trailing: MouseRegion(
                cursor: SystemMouseCursors.click,
                child: GestureDetector(
                  onTap: () {
                    showCupertinoDialog(
                      context: context,
                      builder: (context) => const DisclaimerDialog(),
                    );
                  },
                  child: Icon(
                    CupertinoIcons.chevron_right,
                    size: 16,
                    color: theme.colorScheme.onSurfaceVariant.withAlpha(100),
                  ),
                ),
              ),
            ),
          ]),
          const SizedBox(height: 20),
        ],
      ),
    );
  }

  Widget _buildHeader(BuildContext context) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          '偏好设置',
          style: TextStyle(
            fontSize: 32,
            fontWeight: FontWeight.w900,
            color: theme.colorScheme.onSurface,
            letterSpacing: -1.0,
          ),
        ),
        const SizedBox(height: 4),
        Container(
          width: 40,
          height: 4,
          decoration: BoxDecoration(
            color: theme.colorScheme.primary,
            borderRadius: BorderRadius.circular(2),
          ),
        ),
      ],
    );
  }

  Widget _buildGroup(
    BuildContext context,
    String title,
    IconData icon,
    List<Widget> items,
  ) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(left: 4, bottom: 16),
          child: Row(
            children: [
              Icon(icon, size: 18, color: theme.colorScheme.primary),
              const SizedBox(width: 10),
              Text(
                title,
                style: const TextStyle(
                  fontSize: 16,
                  fontWeight: FontWeight.w800,
                ),
              ),
            ],
          ),
        ),
        Container(
          decoration: BoxDecoration(
            color: theme.colorScheme.onSurface.withAlpha(10),
            borderRadius: BorderRadius.circular(24),
          ),
          child: Column(
            children: [
              for (int i = 0; i < items.length; i++) ...[
                items[i],
                if (i < items.length - 1)
                  Divider(
                    color: theme.colorScheme.onSurface.withAlpha(5),
                    height: 1,
                    indent: 20,
                    endIndent: 20,
                  ),
              ],
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildItem(
    BuildContext context,
    String title,
    String desc, {
    required Widget trailing,
  }) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 18),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: const TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  desc,
                  style: TextStyle(
                    color: theme.colorScheme.onSurfaceVariant,
                    fontSize: 12,
                    fontWeight: FontWeight.w500,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 16),
          trailing,
        ],
      ),
    );
  }

  Widget _buildAudioDeviceItem(BuildContext context, AudioProvider audio) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _buildItem(
          context,
          '输出设备',
          '选择音频播放输出设备',
          trailing: _buildAudioDeviceDropdown(context, audio),
        ),
        if (_isWasapiSelected(audio)) _buildWasapiWarning(context),
      ],
    );
  }

  Widget _buildShortcutItem(BuildContext context, AppShortcutInfo info) {
    return _buildItem(
      context,
      info.title,
      info.description,
      trailing: _buildShortcutBadge(
        context,
        AppShortcuts.labelFor(info.command),
      ),
    );
  }

  Widget _buildShortcutBadge(BuildContext context, String label) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: theme.colorScheme.onSurface.withAlpha(12),
        borderRadius: BorderRadius.circular(12),
      ),
      child: Text(
        label,
        style: TextStyle(
          color: theme.colorScheme.onSurface,
          fontSize: 12,
          fontWeight: FontWeight.w800,
          fontFamily: 'monospace',
        ),
      ),
    );
  }

  Widget _buildSwitch(
    BuildContext context,
    bool value,
    ValueChanged<bool>? onChanged,
  ) {
    return MouseRegion(
      cursor: onChanged == null
          ? SystemMouseCursors.forbidden
          : SystemMouseCursors.click,
      child: Transform.scale(
        scale: 0.8,
        child: CupertinoSwitch(
          value: value,
          activeTrackColor: Theme.of(context).colorScheme.primary,
          onChanged: onChanged,
        ),
      ),
    );
  }

  Widget _buildSliderItem(
    BuildContext context,
    String title,
    String valueText,
    double value,
    double min,
    double max,
    ValueChanged<double> onChanged,
  ) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 0, 20, 16),
      child: Container(
        padding: const EdgeInsets.all(12),
        decoration: BoxDecoration(
          color: theme.colorScheme.surface.withAlpha(100),
          borderRadius: BorderRadius.circular(16),
        ),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Text(
                        title,
                        style: TextStyle(
                          color: theme.colorScheme.onSurface.withAlpha(150),
                          fontSize: 12,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      Text(
                        valueText,
                        style: TextStyle(
                          color: theme.colorScheme.primary,
                          fontSize: 12,
                          fontWeight: FontWeight.w800,
                          fontFamily: 'monospace',
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 4),
                  SizedBox(
                    height: 32,
                    child: SliderTheme(
                      data: SliderTheme.of(context).copyWith(
                        trackHeight: 4,
                        thumbShape: const RoundSliderThumbShape(
                          enabledThumbRadius: 6,
                        ),
                        overlayShape: const RoundSliderOverlayShape(
                          overlayRadius: 14,
                        ),
                      ),
                      child: MouseRegion(
                        cursor: SystemMouseCursors.click,
                        child: Slider(
                          value: value,
                          min: min,
                          max: max,
                          onChanged: onChanged,
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  String _themeToLabel(String? theme) {
    switch (theme) {
      case 'light':
        return '浅色模式';
      case 'dark':
        return '深色模式';
      default:
        return 'auto';
    }
  }

  String _labelToTheme(String label) {
    switch (label) {
      case '浅色模式':
        return 'light';
      case '深色模式':
        return 'dark';
      default:
        return 'auto';
    }
  }

  Widget _buildDropdown(
    BuildContext context,
    List<String> options,
    String value,
    ValueChanged<String> onChanged,
  ) {
    final theme = Theme.of(context);
    final accentColor = theme.colorScheme.primary;

    return MenuAnchor(
      builder: (context, controller, child) {
        return MouseRegion(
          cursor: SystemMouseCursors.click,
          child: CupertinoButton(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
            color: theme.colorScheme.onSurface.withAlpha(15),
            borderRadius: BorderRadius.circular(12),
            onPressed: () =>
                controller.isOpen ? controller.close() : controller.open(),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  options.contains(value) ? value : options.first,
                  style: TextStyle(
                    color: theme.colorScheme.onSurface,
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                const SizedBox(width: 8),
                Icon(
                  CupertinoIcons.chevron_down,
                  size: 12,
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ],
            ),
          ),
        );
      },
      menuChildren: options.map((option) {
        final isSelected = option == value;
        return MenuItemButton(
          style: ButtonStyle(
            backgroundColor: WidgetStateProperty.resolveWith(
              (states) => states.contains(WidgetState.hovered)
                  ? accentColor.withAlpha(isSelected ? 40 : 20)
                  : Colors.transparent,
            ),
            padding: const WidgetStatePropertyAll(
              EdgeInsets.symmetric(horizontal: 20, vertical: 14),
            ),
            mouseCursor: const WidgetStatePropertyAll(SystemMouseCursors.click),
            overlayColor: const WidgetStatePropertyAll(Colors.transparent),
          ),
          child: Text(
            option,
            style: TextStyle(
              fontSize: 13,
              fontWeight: isSelected ? FontWeight.w800 : FontWeight.w600,
              color: isSelected ? accentColor : theme.colorScheme.onSurface,
            ),
          ),
          onPressed: () => onChanged(option),
        );
      }).toList(),
    );
  }

  Widget _buildAudioDeviceDropdown(BuildContext context, AudioProvider audio) {
    final theme = Theme.of(context);
    final accentColor = theme.colorScheme.primary;
    final realDevices = audio.audioDevices
        .where((d) => d.name != 'auto')
        .toList();
    final devices = [AudioDevice.auto(), ...realDevices];

    final isAuto = audio.userSelectedDevice == null;
    final isPreferredUnavailable = audio.isPreferredDeviceUnavailable;
    final preferredLabel = audio.preferredDeviceDescription ?? '';

    String deviceLabel(AudioDevice d) =>
        d.description.isNotEmpty ? d.description : d.name;

    final selectedDevice = isAuto
        ? AudioDevice.auto()
        : devices.firstWhere(
            (d) => d.name == audio.userSelectedDevice!.name,
            orElse: () => audio.userSelectedDevice!,
          );

    // Button label: active device, or preferred device name (grayed) if unavailable, or '自动'
    String buttonText = isAuto ? '自动' : deviceLabel(selectedDevice);
    Color buttonTextColor = theme.colorScheme.onSurface;
    if (isPreferredUnavailable && preferredLabel.isNotEmpty) {
      buttonText = preferredLabel;
      buttonTextColor = theme.colorScheme.onSurfaceVariant;
    }

    return ConstrainedBox(
      constraints: const BoxConstraints(maxWidth: 200),
      child: MenuAnchor(
        builder: (context, controller, child) {
          return MouseRegion(
            cursor: SystemMouseCursors.click,
            child: CupertinoButton(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
              color: theme.colorScheme.onSurface.withAlpha(15),
              borderRadius: BorderRadius.circular(12),
              onPressed: () =>
                  controller.isOpen ? controller.close() : controller.open(),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Flexible(
                    child: Text(
                      buttonText,
                      overflow: TextOverflow.ellipsis,
                      maxLines: 1,
                      style: TextStyle(
                        color: buttonTextColor,
                        fontSize: 13,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                  if (isPreferredUnavailable) ...[
                    const SizedBox(width: 4),
                    Icon(
                      CupertinoIcons.bolt_slash,
                      size: 11,
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ],
                  const SizedBox(width: 8),
                  Icon(
                    CupertinoIcons.chevron_down,
                    size: 12,
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
                ],
              ),
            ),
          );
        },
        menuChildren: devices.map((device) {
          final isSelected = isAuto && !isPreferredUnavailable
              ? device.name == 'auto'
              : device.name == audio.userSelectedDevice?.name;
          final typeLabel = _deviceTypeLabel(device.name);
          final isWasapi = typeLabel == 'WASAPI';
          final typeBadgeColor = isWasapi
              ? const Color(0xFFF59E0B)
              : theme.colorScheme.onSurfaceVariant;
          return MenuItemButton(
            style: ButtonStyle(
              backgroundColor: WidgetStateProperty.resolveWith(
                (states) => states.contains(WidgetState.hovered)
                    ? accentColor.withAlpha(isSelected ? 40 : 20)
                    : Colors.transparent,
              ),
              padding: const WidgetStatePropertyAll(
                EdgeInsets.symmetric(horizontal: 20, vertical: 10),
              ),
              mouseCursor: const WidgetStatePropertyAll(
                SystemMouseCursors.click,
              ),
              overlayColor: const WidgetStatePropertyAll(Colors.transparent),
            ),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 300),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    device.name == 'auto' ? '自动' : deviceLabel(device),
                    overflow: TextOverflow.ellipsis,
                    maxLines: 1,
                    style: TextStyle(
                      fontSize: 13,
                      fontWeight: isSelected
                          ? FontWeight.w800
                          : FontWeight.w600,
                      color: isSelected
                          ? accentColor
                          : theme.colorScheme.onSurface,
                    ),
                  ),
                  if (typeLabel.isNotEmpty) ...[
                    const SizedBox(height: 2),
                    Text(
                      typeLabel,
                      style: TextStyle(
                        fontSize: 11,
                        fontWeight: FontWeight.w600,
                        color: typeBadgeColor,
                      ),
                    ),
                  ],
                ],
              ),
            ),
            onPressed: () => audio.setAudioDevice(device),
          );
        }).toList(),
      ),
    );
  }

  String _deviceTypeLabel(String name) {
    if (name == 'auto') return '';
    final lower = name.toLowerCase();
    if (lower.startsWith('wasapi/')) return 'WASAPI';
    if (lower.startsWith('coreaudio/')) return 'CoreAudio';
    if (lower.startsWith('pulse/')) return 'PulseAudio';
    if (lower.startsWith('alsa/')) return 'ALSA';
    if (lower.startsWith('jack/')) return 'JACK';
    if (lower.startsWith('openal/')) return 'OpenAL';

    // 兜底：按首个 / 分割，取前缀并转大写
    final slashIndex = name.indexOf('/');
    if (slashIndex > 0) {
      return name.substring(0, slashIndex).toUpperCase();
    }
    return '';
  }

  bool _isWasapiSelected(AudioProvider audio) {
    return audio.userSelectedDevice?.name.toLowerCase().startsWith('wasapi/') ??
        false;
  }

  Widget _buildWasapiWarning(BuildContext context) {
    const warningColor = Color(0xFFF59E0B);
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 0, 20, 18),
      child: Row(
        children: [
          const Icon(
            CupertinoIcons.exclamationmark_triangle,
            size: 13,
            color: warningColor,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              'WASAPI 将独占音频输出设备，其他应用的声音将被静音',
              style: TextStyle(
                color: warningColor.withAlpha(220),
                fontSize: 12,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        ],
      ),
    );
  }

  void _showClearDataDialog(
    BuildContext context,
    PersistenceProvider persistence,
  ) {
    CustomDialog.show(
      context,
      title: '确认清除全部应用数据？',
      content: '此操作将永久移除包括设备身份信息、个性化设置、收藏记录及播放历史在内的所有本地数据。由于该操作不可逆，请谨慎选择。',
      confirmText: '彻底清除',
      isDestructive: true,
    ).then((confirmed) {
      if (confirmed == true) {
        persistence.clearAllData();
        if (mounted) CustomToast.success(this.context, '应用数据已重置');
      }
    });
  }
}
