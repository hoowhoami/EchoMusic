import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../providers/persistence_provider.dart';
import '../../theme/app_theme.dart';

class SettingView extends StatelessWidget {
  const SettingView({super.key});

  @override
  Widget build(BuildContext context) {
    final persistence = context.watch<PersistenceProvider>();
    final settings = persistence.settings;
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final textColor = isDark ? Colors.white : Colors.black87;
    final subTextColor = isDark ? Colors.white54 : Colors.black54;
    final accentColor = Theme.of(context).colorScheme.primary;

    return SingleChildScrollView(
      padding: const EdgeInsets.all(30.0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '偏好设置',
            style: TextStyle(fontSize: 28, fontWeight: FontWeight.bold, color: textColor),
          ),
          const SizedBox(height: 8),
          Text('个性化您的音乐播放体验', style: TextStyle(color: subTextColor, fontSize: 14)),
          const SizedBox(height: 32),
          
          _buildGroup(
            context,
            '外观设置',
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
                '显示播放列表数量',
                '在播放列表图标上显示歌曲数量',
                trailing: Switch(
                  value: settings['showPlaylistCount'] ?? true,
                  onChanged: (v) => persistence.updateSetting('showPlaylistCount', v),
                  activeColor: accentColor,
                ),
              ),
            ],
          ),
          
          const SizedBox(height: 24),
          _buildGroup(
            context,
            '播放设置',
            [
              _buildItem(
                context,
                '歌曲列表添加到播放列表',
                '播放歌曲时将整个歌曲列表添加到本地播放列表',
                trailing: Switch(
                  value: settings['addSongsToPlaylist'] ?? true,
                  onChanged: (v) => persistence.updateSetting('addSongsToPlaylist', v),
                  activeColor: accentColor,
                ),
              ),
              _buildItem(
                context,
                '替换本地播放列表',
                '歌单/专辑等在点击播放全部歌曲时用当前的歌曲列表替换本地播放列表',
                trailing: Switch(
                  value: settings['replacePlaylist'] ?? false,
                  onChanged: (v) => persistence.updateSetting('replacePlaylist', v),
                  activeColor: accentColor,
                ),
              ),
              _buildItem(
                context,
                '音量淡入淡出',
                '播放和暂停时启用音量渐变效果',
                trailing: Switch(
                  value: settings['volumeFade'] ?? true,
                  onChanged: (v) => persistence.updateSetting('volumeFade', v),
                  activeColor: accentColor,
                ),
              ),
              if (settings['volumeFade'] ?? true)
                _buildSliderItem(
                  context,
                  '淡入淡出时间',
                  '${((settings['volumeFadeTime'] ?? 1000) / 1000).toStringAsFixed(1)}s',
                  (settings['volumeFadeTime'] ?? 1000).toDouble(),
                  100,
                  3000,
                  (v) => persistence.updateSetting('volumeFadeTime', v.toInt()),
                ),
              _buildItem(
                context,
                '播放错误时自动下一首',
                '歌曲无法播放时自动跳到下一首',
                trailing: Switch(
                  value: settings['autoNext'] ?? true,
                  onChanged: (v) => persistence.updateSetting('autoNext', v),
                  activeColor: accentColor,
                ),
              ),
              if (settings['autoNext'] ?? true)
                _buildSliderItem(
                  context,
                  '自动跳转延迟',
                  '${((settings['autoNextTime'] ?? 3000) / 1000).toStringAsFixed(1)}s',
                  (settings['autoNextTime'] ?? 3000).toDouble(),
                  1000,
                  10000,
                  (v) => persistence.updateSetting('autoNextTime', v.toInt()),
                ),
              _buildItem(
                context,
                '播放时防止系统休眠',
                '播放音乐时阻止系统进入休眠状态',
                trailing: Switch(
                  value: settings['preventSleep'] ?? true,
                  onChanged: (v) => persistence.updateSetting('preventSleep', v),
                  activeColor: accentColor,
                ),
              ),
            ],
          ),

          const SizedBox(height: 24),
          _buildGroup(
            context,
            '音质设置',
            [
              _buildItem(
                context,
                '兼容模式',
                '当首选音质无法获取时，自动尝试备选音质和兼容播放',
                trailing: Switch(
                  value: settings['compatibilityMode'] ?? true,
                  onChanged: (v) => persistence.updateSetting('compatibilityMode', v),
                  activeColor: accentColor,
                ),
              ),
              _buildItem(
                context,
                '备选音质',
                '兼容模式下的备选音质选择',
                trailing: _buildDropdown(
                  context,
                  ['标准', '高品质', '超高品质', '无损'],
                  settings['backupQuality'] ?? '标准',
                  (v) => persistence.updateSetting('backupQuality', v),
                ),
              ),
            ],
          ),

          const SizedBox(height: 24),
          _buildGroup(
            context,
            '实验功能',
            [
              _buildItem(
                context,
                '自动领取畅听VIP',
                '每天自动领取畅听VIP解锁基础听歌权限',
                trailing: Switch(
                  value: settings['autoSign'] ?? false,
                  onChanged: (v) => persistence.updateSetting('autoSign', v),
                  activeColor: accentColor,
                ),
              ),
              _buildItem(
                context,
                '自动升级概念VIP',
                '每天自动升级至概念VIP解锁顶级音质和音效',
                trailing: Switch(
                  value: settings['autoReceiveVip'] ?? false,
                  onChanged: (v) => persistence.updateSetting('autoReceiveVip', v),
                  activeColor: accentColor,
                ),
              ),
            ],
          ),

          const SizedBox(height: 24),
          _buildGroup(
            context,
            '关于',
            [
              _buildItem(
                context,
                'EchoMusic',
                '版本 v1.0.0',
                trailing: Text('检查更新', style: TextStyle(color: accentColor, fontSize: 13, fontWeight: FontWeight.bold)),
              ),
              _buildItem(
                context,
                '开源地址',
                'https://github.com/hoowhoami/EchoMusic.git',
                trailing: Icon(Icons.open_in_new, size: 16, color: subTextColor),
              ),
            ],
          ),
          const SizedBox(height: 100),
        ],
      ),
    );
  }

  Widget _buildSliderItem(BuildContext context, String title, String valueText, double value, double min, double max, ValueChanged<double> onChanged) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: TextStyle(color: isDark ? Colors.white70 : Colors.black87, fontSize: 13, fontWeight: FontWeight.w500)),
                Slider(
                  value: value,
                  min: min,
                  max: max,
                  onChanged: onChanged,
                  activeColor: Theme.of(context).colorScheme.primary,
                ),
              ],
            ),
          ),
          const SizedBox(width: 12),
          Text(valueText, style: TextStyle(color: isDark ? Colors.white38 : Colors.black38, fontSize: 12)),
        ],
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

  Widget _buildGroup(BuildContext context, String title, List<Widget> items) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final accentColor = Theme.of(context).colorScheme.primary;
    
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(left: 4, bottom: 12),
          child: Text(
            title,
            style: TextStyle(fontSize: 14, fontWeight: FontWeight.w800, color: accentColor, letterSpacing: 1.2),
          ),
        ),
        Container(
          decoration: BoxDecoration(
            color: isDark ? Colors.white.withAlpha(12) : Colors.black.withAlpha(8),
            borderRadius: BorderRadius.circular(16),
          ),
          child: Column(
            children: [
              for (int i = 0; i < items.length; i++) ...[
                items[i],
                if (i < items.length - 1)
                  Divider(color: isDark ? Colors.white.withAlpha(10) : Colors.black.withAlpha(10), height: 1, indent: 16, endIndent: 16),
              ],
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildItem(BuildContext context, String title, String desc, {required Widget trailing}) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return Padding(
      padding: const EdgeInsets.all(20.0),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: TextStyle(color: isDark ? Colors.white : Colors.black, fontSize: 15, fontWeight: FontWeight.w600)),
                const SizedBox(height: 4),
                Text(desc, style: TextStyle(color: isDark ? Colors.white38 : Colors.black38, fontSize: 12)),
              ],
            ),
          ),
          const SizedBox(width: 20),
          trailing,
        ],
      ),
    );
  }

  Widget _buildDropdown(BuildContext context, List<String> options, String value, ValueChanged<String> onChanged) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      decoration: BoxDecoration(
        color: isDark ? Colors.white.withAlpha(15) : Colors.black.withAlpha(10),
        borderRadius: BorderRadius.circular(8),
      ),
      child: DropdownButton<String>(
        value: options.contains(value) ? value : options.first,
        items: options.map((e) => DropdownMenuItem(
          value: e,
          child: Text(e, style: TextStyle(color: isDark ? Colors.white : Colors.black, fontSize: 13)),
        )).toList(),
        onChanged: (v) {
          if (v != null) onChanged(v);
        },
        underline: const SizedBox(),
        icon: Icon(Icons.keyboard_arrow_down, size: 18, color: isDark ? Colors.white30 : Colors.black38),
        dropdownColor: isDark ? const Color(0xFF1E293B) : Colors.white,
      ),
    );
  }
}
