import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import '../../providers/persistence_provider.dart';
import '../../utils/constants.dart';
import '../widgets/scrollable_content.dart';
import '../widgets/custom_dialog.dart';

class SettingView extends StatelessWidget {
  const SettingView({super.key});

  @override
  Widget build(BuildContext context) {
    final persistence = context.watch<PersistenceProvider>();
    final settings = persistence.settings;
    final theme = Theme.of(context);
    final accentColor = theme.colorScheme.primary;

    return ScrollableContent(
      padding: const EdgeInsets.symmetric(horizontal: 40, vertical: 40),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _buildHeader(context),
          const SizedBox(height: 40),

          _buildGroup(
            context,
            '外观与界面',
            CupertinoIcons.paintbrush,
            [
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
            ],
          ),

          const SizedBox(height: 32),
          _buildGroup(
            context,
            '播放体验',
            CupertinoIcons.play_circle,
            [
              _buildItem(
                context,
                '自动添加歌曲',
                '播放歌曲时将整个列表添加到队列',
                trailing: _buildSwitch(
                  context,
                  settings['addSongsToPlaylist'] ?? true,
                  (v) => persistence.updateSetting('addSongsToPlaylist', v),
                ),
              ),
              _buildItem(
                context,
                '播放替换队列',
                '点击播放全部时替换当前播放列表',
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
                  settings['autoNext'] ?? true,
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
            ],
          ),

          const SizedBox(height: 32),
          _buildGroup(
            context,
            '播放音质',
            CupertinoIcons.waveform_circle,
            [
              _buildItem(
                context,
                '首选音质',
                '根据网络环境选择播放音质',
                trailing: _buildDropdown(
                  context,
                  AudioQuality.options.map((o) => o.label).toList(),
                  AudioQuality.getLabel(settings['audioQuality'] ?? 'flac'),
                  (label) {
                    final value = AudioQuality.options.firstWhere((o) => o.label == label).value;
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
              _buildItem(
                context,
                '备选音质',
                '兼容模式下的备选音质级别',
                trailing: _buildDropdown(
                  context,
                  AudioQuality.options.map((o) => o.label).toList(),
                  AudioQuality.getLabel(settings['backupQuality'] ?? '128'),
                  (label) {
                    final value = AudioQuality.options.firstWhere((o) => o.label == label).value;
                    persistence.updateSetting('backupQuality', value);
                  },
                ),
              ),
            ],
          ),

          const SizedBox(height: 32),
          _buildGroup(
            context,
            '数据与安全',
            CupertinoIcons.shield,
            [
              _buildItem(
                context,
                '清除应用数据',
                '移除所有持久化设置及缓存信息',
                trailing: CupertinoButton(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                  color: theme.colorScheme.error.withAlpha(20),
                  borderRadius: BorderRadius.circular(10),
                  onPressed: () => _showClearDataDialog(context, persistence),
                  child: Text(
                    '立即清除',
                    style: TextStyle(color: theme.colorScheme.error, fontSize: 13, fontWeight: FontWeight.w800),
                  ),
                ),
              ),
            ],
          ),

          const SizedBox(height: 32),
          _buildGroup(
            context,
            '关于 EchoMusic',
            CupertinoIcons.info_circle,
            [
              _buildItem(
                context,
                '当前版本',
                'Version v1.0.0 Stable',
                trailing: Text('检查更新', style: TextStyle(color: accentColor, fontSize: 13, fontWeight: FontWeight.w800)),
              ),
              _buildItem(
                context,
                '项目源码',
                '开源共享于 GitHub',
                trailing: Icon(CupertinoIcons.arrow_up_right_circle, size: 20, color: theme.colorScheme.onSurfaceVariant.withAlpha(100)),
              ),
            ],
          ),
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

  Widget _buildGroup(BuildContext context, String title, IconData icon, List<Widget> items) {
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
                style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800),
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
                  Divider(color: theme.colorScheme.onSurface.withAlpha(5), height: 1, indent: 20, endIndent: 20),
              ],
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildItem(BuildContext context, String title, String desc, {required Widget trailing}) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 18),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700)),
                const SizedBox(height: 4),
                Text(desc, style: TextStyle(color: theme.colorScheme.onSurfaceVariant, fontSize: 12, fontWeight: FontWeight.w500)),
              ],
            ),
          ),
          const SizedBox(width: 16),
          trailing,
        ],
      ),
    );
  }

  Widget _buildSwitch(BuildContext context, bool value, ValueChanged<bool> onChanged) {
    return MouseRegion(
      cursor: SystemMouseCursors.click,
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

  Widget _buildSliderItem(BuildContext context, String title, String valueText, double value, double min, double max, ValueChanged<double> onChanged) {
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
                      Text(title, style: TextStyle(color: theme.colorScheme.onSurface.withAlpha(150), fontSize: 12, fontWeight: FontWeight.w700)),
                      Text(valueText, style: TextStyle(color: theme.colorScheme.primary, fontSize: 12, fontWeight: FontWeight.w800, fontFamily: 'monospace')),
                    ],
                  ),
                  const SizedBox(height: 4),
                  SizedBox(
                    height: 32,
                    child: SliderTheme(
                      data: SliderTheme.of(context).copyWith(
                        trackHeight: 4,
                        thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 6),
                        overlayShape: const RoundSliderOverlayShape(overlayRadius: 14),
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
      case 'light': return '浅色模式';
      case 'dark': return '深色模式';
      default: return '跟随系统';
    }
  }

  String _labelToTheme(String label) {
    switch (label) {
      case '浅色模式': return 'light';
      case '深色模式': return 'dark';
      default: return 'auto';
    }
  }

  Widget _buildDropdown(BuildContext context, List<String> options, String value, ValueChanged<String> onChanged) {
    final theme = Theme.of(context);
    final accentColor = theme.colorScheme.primary;

    return MenuAnchor(
      builder: (context, controller, child) {
        return MouseRegion(
          cursor: SystemMouseCursors.click,
          child: CupertinoButton(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
            color: theme.colorScheme.onSurface.withAlpha(10),
            borderRadius: BorderRadius.circular(10),
            onPressed: () => controller.isOpen ? controller.close() : controller.open(),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  options.contains(value) ? value : options.first,
                  style: TextStyle(color: theme.colorScheme.onSurface, fontSize: 13, fontWeight: FontWeight.w700),
                ),
                const SizedBox(width: 6),
                Icon(CupertinoIcons.chevron_down, size: 12, color: theme.colorScheme.onSurfaceVariant),
              ],
            ),
          ),
        );
      },
      menuChildren: options.map((option) {
        final isSelected = option == value;
        return MenuItemButton(
          style: ButtonStyle(
            backgroundColor: WidgetStateProperty.resolveWith((states) => states.contains(WidgetState.hovered) ? accentColor.withAlpha(20) : null),
            padding: const WidgetStatePropertyAll(EdgeInsets.symmetric(horizontal: 16, vertical: 12)),
            mouseCursor: const WidgetStatePropertyAll(SystemMouseCursors.click),
          ),
          child: Text(option, style: TextStyle(fontSize: 13, fontWeight: isSelected ? FontWeight.w800 : FontWeight.w500, color: isSelected ? accentColor : null)),
          onPressed: () => onChanged(option),
        );
      }).toList(),
    );
  }

  void _showClearDataDialog(BuildContext context, PersistenceProvider persistence) {
    CustomDialog.show(
      context,
      title: '确认清除全部应用数据？',
      content: '此操作将永久移除包括设备身份信息、个性化设置、收藏记录及播放历史在内的所有本地数据。由于该操作不可逆，请谨慎选择。',
      confirmText: '彻底清除',
      isDestructive: true,
    ).then((confirmed) {
      if (confirmed == true) {
        persistence.clearAllData();
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: const Text('应用数据已重置'),
            behavior: SnackBarBehavior.floating,
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
            margin: const EdgeInsets.all(20),
          ),
        );
      }
    });
  }
}