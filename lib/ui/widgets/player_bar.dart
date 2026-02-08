import 'dart:ui';
import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter/gestures.dart';
import 'package:provider/provider.dart';
import 'package:audio_video_progress_bar/audio_video_progress_bar.dart';
import '../../theme/app_theme.dart';
import '../../providers/audio_provider.dart';
import '../../providers/persistence_provider.dart';
import '../../providers/user_provider.dart';
import '../../utils/constants.dart';
import '../screens/lyric_page.dart';
import 'cover_image.dart';
import 'queue_drawer.dart';

class PlayerBar extends StatefulWidget {
  const PlayerBar({super.key});

  @override
  State<PlayerBar> createState() => _PlayerBarState();
}

class _PlayerBarState extends State<PlayerBar> {
  final LayerLink _volumeLink = LayerLink();
  final LayerLink _qualityEffectLink = LayerLink();
  final LayerLink _speedLink = LayerLink();
  final LayerLink _playModeLink = LayerLink();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final modernTheme = theme.extension<AppModernTheme>();
    final accentColor = theme.colorScheme.primary;

    return Consumer2<AudioProvider, PersistenceProvider>(
      builder: (context, audioProvider, persistenceProvider, child) {
        final song = audioProvider.currentSong;

        return Container(
          height: 80,
          decoration: BoxDecoration(
            color: modernTheme?.playerBarColor ?? theme.colorScheme.surface,
            border: Border(
              top: BorderSide(
                color: (modernTheme?.dividerColor ?? theme.dividerColor).withAlpha(30),
                width: 0.5,
              ),
            ),
          ),
          child: Stack(
            clipBehavior: Clip.none,
            children: [
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 24),
                child: song == null
                    ? _buildEmptyState(context, accentColor)
                    : _buildPlayerContent(context, song, audioProvider, persistenceProvider, theme, accentColor),
              ),
              if (song != null)
                Positioned(
                  top: -10,
                  left: 0,
                  right: 0,
                  child: _buildIntegratedProgressBar(audioProvider, accentColor, theme),
                ),
            ],
          ),
        );
      },
    );
  }

  Widget _buildIntegratedProgressBar(AudioProvider audioProvider, Color accentColor, ThemeData theme) {
    return LayoutBuilder(
      builder: (context, constraints) {
        return MouseRegion(
          cursor: SystemMouseCursors.click,
          child: Container(
            height: 20,
            width: double.infinity,
            color: Colors.transparent,
            child: Stack(
              alignment: Alignment.centerLeft,
              children: [
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 0),
                  child: StreamBuilder<Duration>(
                    stream: audioProvider.player.stream.position,
                    builder: (context, snapshot) {
                      final position = snapshot.data ?? Duration.zero;
                      final total = audioProvider.player.state.duration;
                      return ProgressBar(
                        progress: position,
                        total: total,
                        barHeight: 4.0,
                        baseBarColor: theme.colorScheme.onSurface.withAlpha(20),
                        progressBarColor: accentColor,
                        thumbColor: accentColor,
                        thumbRadius: 7.0,
                        thumbGlowRadius: 15.0,
                        onSeek: (duration) => audioProvider.player.seek(duration),
                        timeLabelLocation: TimeLabelLocation.none,
                      );
                    },
                  ),
                ),
                ...audioProvider.climaxMarks.entries.map((entry) {
                  final start = entry.key;
                  final end = entry.value;
                  final barWidth = (end - start) * constraints.maxWidth;
                  return Positioned(
                    left: constraints.maxWidth * start,
                    child: IgnorePointer(
                      child: Container(
                        width: barWidth.clamp(6.0, constraints.maxWidth),
                        height: 4,
                        decoration: BoxDecoration(
                          color: theme.colorScheme.onPrimary.withAlpha(180),
                          borderRadius: BorderRadius.circular(2),
                          boxShadow: [
                            BoxShadow(color: accentColor.withAlpha(80), blurRadius: 4),
                          ],
                        ),
                      ),
                    ),
                  );
                }),
              ],
            ),
          ),
        );
      }
    );
  }

  Widget _buildEmptyState(BuildContext context, Color accentColor) {
    final theme = Theme.of(context);
    return Row(
      children: [
        SizedBox(
          width: 320,
          child: Row(
            children: [
              Container(
                width: 52, height: 52,
                decoration: BoxDecoration(color: theme.colorScheme.onSurface.withAlpha(10), borderRadius: BorderRadius.circular(8)),
                child: Icon(CupertinoIcons.music_note, color: theme.colorScheme.onSurface.withAlpha(50)),
              ),
              const SizedBox(width: 14),
              Column(
                mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Container(width: 120, height: 14, decoration: BoxDecoration(color: theme.colorScheme.onSurface.withAlpha(10), borderRadius: BorderRadius.circular(4))),
                  const SizedBox(height: 6),
                  Container(width: 80, height: 10, decoration: BoxDecoration(color: theme.colorScheme.onSurface.withAlpha(10), borderRadius: BorderRadius.circular(4))),
                ],
              ),
            ],
          ),
        ),
        Expanded(
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(CupertinoIcons.backward_fill, size: 22, color: theme.colorScheme.onSurface.withAlpha(40)),
              const SizedBox(width: 28),
              Container(
                width: 44, height: 44,
                decoration: BoxDecoration(shape: BoxShape.circle, color: theme.colorScheme.onSurface.withAlpha(5)),
                child: Center(child: Icon(CupertinoIcons.play_fill, size: 24, color: theme.disabledColor)),
              ),
              const SizedBox(width: 28),
              Icon(CupertinoIcons.forward_fill, size: 22, color: theme.colorScheme.onSurface.withAlpha(40)),
            ],
          ),
        ),
        const SizedBox(width: 540),
      ],
    );
  }

  Widget _buildPlayerContent(
    BuildContext context,
    dynamic song,
    AudioProvider audioProvider,
    PersistenceProvider persistenceProvider,
    ThemeData theme,
    Color accentColor,
  ) {
    final userProvider = context.watch<UserProvider>();
    
    return Row(
      children: [
        SizedBox(
          width: 300,
          child: Row(
            children: [
              InkWell(
                onTap: () => Navigator.push(context, CupertinoPageRoute(builder: (_) => const LyricPage())),
                borderRadius: BorderRadius.circular(12),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    AnimatedSwitcher(
                      duration: const Duration(milliseconds: 400),
                      transitionBuilder: (child, animation) => FadeTransition(opacity: animation, child: child),
                      child: Hero(
                        key: ValueKey(song.hash),
                        tag: 'player_cover',
                        child: CoverImage(url: song.cover, width: 52, height: 52, borderRadius: 8, size: 100, showShadow: true),
                      ),
                    ),
                    const SizedBox(width: 14),
                    ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: 140),
                      child: AnimatedSwitcher(
                        duration: const Duration(milliseconds: 400),
                        layoutBuilder: (currentChild, previousChildren) => Stack(
                          alignment: Alignment.centerLeft,
                          children: [
                            ...previousChildren,
                            if (currentChild != null) currentChild,
                          ],
                        ),
                        child: Column(
                          key: ValueKey(song.hash),
                          mainAxisAlignment: MainAxisAlignment.center,
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(song.name, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15), maxLines: 1, overflow: TextOverflow.ellipsis),
                            const SizedBox(height: 2),
                            Text(song.singerName, style: TextStyle(color: theme.colorScheme.onSurface.withAlpha(140), fontSize: 12, fontWeight: FontWeight.w600), maxLines: 1, overflow: TextOverflow.ellipsis),
                          ],
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 8),
              if (song.source == 'cloud')
                _PlayerIconButton(icon: CupertinoIcons.cloud_fill, size: 16, activeColor: accentColor, isSelected: true, onPressed: (){}, tooltip: '云盘歌曲'),
              if (userProvider.isAuthenticated)
                AnimatedSwitcher(
                  duration: const Duration(milliseconds: 300),
                  child: _PlayerIconButton(
                    key: ValueKey('${song.hash}_${persistenceProvider.isFavorite(song)}'),
                    icon: persistenceProvider.isFavorite(song) ? CupertinoIcons.heart_fill : CupertinoIcons.heart,
                    isSelected: persistenceProvider.isFavorite(song),
                    activeColor: Colors.redAccent,
                    onPressed: () => persistenceProvider.toggleFavorite(song, userProvider: userProvider),
                    size: 20, tooltip: '收藏',
                  ),
                ),
            ],
          ),
        ),

        Expanded(
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              _PlayerIconButton(icon: CupertinoIcons.backward_fill, onPressed: audioProvider.previous, size: 26, tooltip: '上一首'),
              const SizedBox(width: 24),
              _buildPlayButton(theme, audioProvider),
              const SizedBox(width: 24),
              _PlayerIconButton(icon: CupertinoIcons.forward_fill, onPressed: audioProvider.next, size: 26, tooltip: '下一首'),
            ],
          ),
        ),

        SizedBox(
          width: 440,
          child: Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              _buildTimeInfo(audioProvider),
              const SizedBox(width: 16),
              CompositedTransformTarget(
                link: _playModeLink,
                child: _buildLoopModeButton(audioProvider),
              ),
              const SizedBox(width: 12),
              CompositedTransformTarget(
                link: _speedLink,
                child: _PlayerIconButton(
                  icon: CupertinoIcons.speedometer,
                  isSelected: audioProvider.playbackRate != 1.0,
                  onPressed: () => _showCustomPopup(context, _speedLink, const _SpeedPopup(), width: 120, height: 340),
                  size: 20, tooltip: '播放倍速',
                ),
              ),
              const SizedBox(width: 12),
              CompositedTransformTarget(
                link: _qualityEffectLink,
                child: _PlayerIconButton(
                  icon: CupertinoIcons.waveform,
                  onPressed: song.source == 'cloud' ? null : () => _showCustomPopup(context, _qualityEffectLink, const _QualityEffectPopup(), width: 180, height: 380),
                  size: 20, tooltip: '音质选择',
                  isSelected: true,
                ),
              ),
              const SizedBox(width: 12),
              CompositedTransformTarget(
                link: _volumeLink,
                child: _PlayerIconButton(
                  icon: _getVolumeIcon(persistenceProvider.volume),
                  isSelected: persistenceProvider.volume > 0,
                  onPressed: () => _showCustomPopup(context, _volumeLink, const _VolumePopup(), width: 50, height: 200),
                  onScroll: (delta) {
                    final newVol = (persistenceProvider.volume + (delta > 0 ? -0.05 : 0.05)).clamp(0.0, 1.0);
                    audioProvider.setVolume(newVol);
                  },
                  size: 20, tooltip: '音量',
                ),
              ),
              const SizedBox(width: 12),
              _PlayerIconButton(icon: CupertinoIcons.list_bullet, onPressed: () => _showQueueDrawer(context), size: 22, tooltip: '播放队列'),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildPlayButton(ThemeData theme, AudioProvider audioProvider) {
    return _PlayPauseButton(audioProvider: audioProvider);
  }

  Widget _buildLoopModeButton(AudioProvider audioProvider) {
    final mode = audioProvider.playMode;
    IconData icon = CupertinoIcons.repeat;
    String tip = '列表循环';
    if (mode == 'repeat-once') { icon = CupertinoIcons.repeat_1; tip = '单曲循环'; }
    else if (mode == 'shuffle') { icon = CupertinoIcons.shuffle; tip = '随机播放'; }
    
    return _PlayerIconButton(
      icon: icon, isSelected: true, 
      onPressed: () => _showCustomPopup(context, _playModeLink, const _PlayModePopup(), width: 140, height: 180),
      size: 20, tooltip: tip,
    );
  }

  void _showPlayModeDropdown(BuildContext context, AudioProvider audioProvider) {
    final RenderBox button = context.findRenderObject() as RenderBox;
    final RenderBox overlay = Overlay.of(context).context.findRenderObject() as RenderBox;
    final Offset offset = button.localToGlobal(Offset.zero, ancestor: overlay);
    final RelativeRect position = RelativeRect.fromLTRB(
      offset.dx, offset.dy - 140, 
      overlay.size.width - offset.dx - button.size.width, overlay.size.height - offset.dy,
    );

    showMenu(
      context: context, position: position, elevation: 8,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      items: [
        PopupMenuItem(value: 'repeat', child: Row(children: const [Icon(CupertinoIcons.repeat, size: 18), SizedBox(width: 10), Text('列表循环', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600))])),
        PopupMenuItem(value: 'repeat-once', child: Row(children: const [Icon(CupertinoIcons.repeat_1, size: 18), SizedBox(width: 10), Text('单曲循环', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600))])),
        PopupMenuItem(value: 'shuffle', child: Row(children: const [Icon(CupertinoIcons.shuffle, size: 18), SizedBox(width: 10), Text('随机播放', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600))])),
      ],
    ).then((value) {
      if (value != null) audioProvider.setPlayMode(value);
    });
  }

  Widget _buildTimeInfo(AudioProvider audioProvider) {
    final theme = Theme.of(context);
    return StreamBuilder<Duration>(
      stream: audioProvider.player.stream.position,
      builder: (context, snapshot) {
        final position = snapshot.data ?? Duration.zero;
        final total = audioProvider.player.state.duration;
        return Text(
          '${_formatDuration(position)} / ${_formatDuration(total)}',
          style: TextStyle(fontSize: 11, fontFamily: 'monospace', color: theme.colorScheme.onSurface.withAlpha(120), fontWeight: FontWeight.w600),
        );
      },
    );
  }

  Widget _buildTextActionButton({required String label, required VoidCallback? onTap, IconData? icon, bool isHighlight = false, bool disabled = false}) {
    final theme = Theme.of(context);
    final color = disabled ? theme.disabledColor : (isHighlight ? theme.colorScheme.primary : theme.colorScheme.onSurface.withAlpha(180));
    return MouseRegion(
      cursor: disabled ? SystemMouseCursors.basic : SystemMouseCursors.click,
      child: GestureDetector(
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(6),
            border: isHighlight && !disabled ? Border.all(color: theme.colorScheme.primary.withAlpha(120), width: 1.2) : null,
            color: isHighlight && !disabled ? theme.colorScheme.primary.withAlpha(15) : Colors.transparent,
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (icon != null) ...[Icon(icon, size: 14, color: color), const SizedBox(width: 4)],
              Text(label, style: TextStyle(fontSize: 11, fontWeight: FontWeight.w900, color: color)),
            ],
          ),
        ),
      ),
    );
  }

  void _showCustomPopup(BuildContext context, LayerLink link, Widget content, {required double width, required double height}) {
    late OverlayEntry entry;
    entry = OverlayEntry(
      builder: (_) => Stack(
        children: [
          GestureDetector(onTap: () => entry.remove(), behavior: HitTestBehavior.translucent, child: Container(color: Colors.transparent)),
          CompositedTransformFollower(
            link: link, showWhenUnlinked: false, offset: Offset(-(width / 2) + 16, -(height + 16)),
            child: Material(color: Colors.transparent, child: _PlayerPopupContainer(width: width, height: height, child: content)),
          ),
        ],
      ),
    );
    Overlay.of(context).insert(entry);
  }

  String _getQualityEffectLabel(PersistenceProvider p) {
    final qVal = p.playerSettings['audioQuality'] ?? p.settings['audioQuality'] ?? 'flac';
    final eVal = p.playerSettings['audioEffect'] ?? p.settings['audioEffect'] ?? 'none';
    
    final q = qVal == '128' ? '标准' : (qVal == '320' ? 'HQ' : 'SQ');
    final e = AudioEffect.getLabel(eVal);
    return e == '原声' ? q : '$q · $e';
  }

  IconData _getVolumeIcon(double vol) {
    if (vol == 0) return CupertinoIcons.speaker_slash_fill;
    if (vol < 0.5) return CupertinoIcons.speaker_1_fill;
    return CupertinoIcons.speaker_2_fill;
  }

  String _formatDuration(Duration duration) {
    String twoDigits(int n) => n.toString().padLeft(2, "0");
    return "${twoDigits(duration.inMinutes.remainder(60))}:${twoDigits(duration.inSeconds.remainder(60))}";
  }

  void _showQueueDrawer(BuildContext context) {
    final theme = Theme.of(context);
    showGeneralDialog(
      context: context, barrierLabel: 'Queue', barrierDismissible: true,
      barrierColor: theme.colorScheme.scrim.withAlpha(20),
      transitionDuration: const Duration(milliseconds: 300),
      pageBuilder: (context, _, __) => Align(
        alignment: Alignment.centerRight,
        child: Padding(
          padding: const EdgeInsets.only(bottom: 80),
          child: Material(elevation: 20, borderRadius: const BorderRadius.horizontal(left: Radius.circular(16)), child: SizedBox(width: 380, child: const QueueDrawer())),
        ),
      ),
      transitionBuilder: (context, anim, _, child) => SlideTransition(
        position: Tween<Offset>(begin: const Offset(1, 0), end: Offset.zero).animate(CurvedAnimation(parent: anim, curve: Curves.easeOutCubic)),
        child: child,
      ),
    );
  }
}

// --- Popup Widgets ---

class _PlayModePopup extends StatelessWidget {
  const _PlayModePopup();
  @override
  Widget build(BuildContext context) {
    final audio = context.watch<AudioProvider>();
    return Column(
      children: [
        _buildPopupHeader(context, '播放模式'),
        _buildPopupItem(context, label: '列表循环', isSelected: audio.playMode == 'repeat', icon: CupertinoIcons.repeat, onTap: () => audio.setPlayMode('repeat')),
        _buildPopupItem(context, label: '单曲循环', isSelected: audio.playMode == 'repeat-once', icon: CupertinoIcons.repeat_1, onTap: () => audio.setPlayMode('repeat-once')),
        _buildPopupItem(context, label: '随机播放', isSelected: audio.playMode == 'shuffle', icon: CupertinoIcons.shuffle, onTap: () => audio.setPlayMode('shuffle')),
      ],
    );
  }
}

class _SpeedPopup extends StatelessWidget {
  const _SpeedPopup();
  @override
  Widget build(BuildContext context) {
    final audio = context.watch<AudioProvider>();
    return Column(
      children: [
        _buildPopupHeader(context, '播放倍速'),
        Expanded(
          child: ListView(
            padding: EdgeInsets.zero,
            children: PlaySpeed.options.map((s) => _buildPopupItem(
              context, label: '${s}x', isSelected: audio.playbackRate == s, onTap: () => audio.setPlaybackRate(s),
            )).toList(),
          ),
        ),
      ],
    );
  }
}

class _QualityEffectPopup extends StatelessWidget {
  const _QualityEffectPopup();
  @override
  Widget build(BuildContext context) {
    final audio = context.watch<AudioProvider>();
    final persistence = context.watch<PersistenceProvider>();
    final currentQuality = persistence.playerSettings['audioQuality'] ?? persistence.settings['audioQuality'] ?? 'flac';
    final currentEffect = persistence.playerSettings['audioEffect'] ?? persistence.settings['audioEffect'] ?? 'none';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _buildPopupHeader(context, '音质选择'),
        ...AudioQuality.options.map((q) => _buildPopupItem(
          context, label: q.label, isSelected: currentQuality == q.value, onTap: () => audio.updateAudioSetting('audioQuality', q.value),
        )),
        const Divider(height: 16),
        _buildPopupHeader(context, '音效设置'),
        Expanded(
          child: ListView(
            padding: EdgeInsets.zero,
            children: AudioEffect.options.map((e) => _buildPopupItem(
              context, label: e.label, isSelected: currentEffect == e.value, onTap: () => audio.updateAudioSetting('audioEffect', e.value),
            )).toList(),
          ),
        ),
      ],
    );
  }
}

class _VolumePopup extends StatelessWidget {
  const _VolumePopup();
  @override
  Widget build(BuildContext context) {
    final audio = context.watch<AudioProvider>();
    final persistence = context.watch<PersistenceProvider>();
    final theme = Theme.of(context);
    return StreamBuilder<double>(
      stream: audio.userVolumeStream, initialData: persistence.volume,
      builder: (context, snapshot) {
        final vol = snapshot.data ?? 1.0;
        return Column(
          children: [
            const SizedBox(height: 12),
            Text('${(vol * 100).toInt()}%', style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold)),
            Expanded(child: RotatedBox(quarterTurns: 3, child: SliderTheme(data: theme.sliderTheme.copyWith(trackHeight: 4, thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 6)), child: Slider(value: vol, onChanged: (v) => audio.setVolume(v))))),
            const SizedBox(height: 8),
            MouseRegion(
              cursor: SystemMouseCursors.click,
              child: GestureDetector(
                onTap: () => audio.toggleMute(),
                child: Icon(vol == 0 ? CupertinoIcons.speaker_slash_fill : (vol < 0.5 ? CupertinoIcons.speaker_1_fill : CupertinoIcons.speaker_2_fill), size: 18, color: theme.colorScheme.primary),
              ),
            ),
            const SizedBox(height: 12),
          ],
        );
      }
    );
  }
}

Widget _buildPopupHeader(BuildContext context, String title) => Padding(padding: const EdgeInsets.fromLTRB(16, 12, 16, 8), child: Text(title, style: TextStyle(fontSize: 10, fontWeight: FontWeight.w900, color: Theme.of(context).colorScheme.onSurface.withAlpha(100), letterSpacing: 1.2)));
Widget _buildPopupItem(BuildContext context, {required String label, required bool isSelected, required VoidCallback onTap, IconData? icon}) {
  final theme = Theme.of(context);
  return InkWell(
    onTap: onTap,
    child: Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      child: Row(
        children: [
          if (icon != null) ...[Icon(icon, size: 16, color: isSelected ? theme.colorScheme.primary : theme.colorScheme.onSurface.withAlpha(150)), const SizedBox(width: 10)],
          Expanded(child: Text(label, style: TextStyle(fontSize: 13, fontWeight: isSelected ? FontWeight.w800 : FontWeight.w600, color: isSelected ? theme.colorScheme.primary : null))),
          if (isSelected) Icon(CupertinoIcons.checkmark_alt, size: 16, color: theme.colorScheme.primary)
        ],
      ),
    ),
  );
}

class _PlayerPopupContainer extends StatelessWidget {
  final double width; final double height; final Widget child;
  const _PlayerPopupContainer({required this.width, required this.height, required this.child});
  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final backgroundColor = theme.colorScheme.surface.withAlpha(240);
    final borderColor = theme.dividerTheme.color ?? theme.dividerColor.withAlpha(20);
    return Stack(
      clipBehavior: Clip.none,
      children: [
        Container(
          width: width, height: height,
          decoration: BoxDecoration(color: backgroundColor, borderRadius: BorderRadius.circular(16), border: Border.all(color: borderColor, width: 1), boxShadow: [BoxShadow(color: Colors.black.withAlpha(30), blurRadius: 20, offset: const Offset(0, 4))]),
          child: ClipRRect(borderRadius: BorderRadius.circular(16), child: BackdropFilter(filter: ImageFilter.blur(sigmaX: 15, sigmaY: 15), child: child)),
        ),
        Positioned(bottom: -8, left: (width / 2) - 8, child: CustomPaint(painter: _PopupArrowPainter(color: backgroundColor, borderColor: borderColor), size: const Size(16, 8))),
      ],
    );
  }
}

class _PopupArrowPainter extends CustomPainter {
  final Color color; final Color borderColor;
  _PopupArrowPainter({required this.color, required this.borderColor});
  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()..color = color..style = PaintingStyle.fill;
    final borderPaint = Paint()..color = borderColor..style = PaintingStyle.stroke..strokeWidth = 1;
    final path = Path()..moveTo(0, 0)..lineTo(size.width / 2, size.height)..lineTo(size.width, 0)..close();
    canvas.drawPath(path, paint);
    final borderPath = Path()..moveTo(0, 0)..lineTo(size.width / 2, size.height)..lineTo(size.width, 0);
    canvas.drawPath(borderPath, borderPaint);
  }
  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

class _PlayerIconButton extends StatefulWidget {
  final IconData icon; final VoidCallback? onPressed; final VoidCallback? onSecondaryPressed; final Function(double)? onScroll;
  final double size; final bool isSelected; final Color? activeColor; final String? tooltip;
  const _PlayerIconButton({super.key, required this.icon, this.onPressed, this.onSecondaryPressed, this.onScroll, this.size = 20, this.isSelected = false, this.activeColor, this.tooltip});
  @override
  State<_PlayerIconButton> createState() => _PlayerIconButtonState();
}

class _PlayerIconButtonState extends State<_PlayerIconButton> {
  bool _isHovered = false;
  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final disabled = widget.onPressed == null;
    final color = disabled 
        ? theme.disabledColor 
        : (_isHovered || widget.isSelected ? (widget.activeColor ?? theme.colorScheme.primary) : theme.colorScheme.onSurfaceVariant.withAlpha(180));
    
    return MouseRegion(
      cursor: disabled ? SystemMouseCursors.basic : SystemMouseCursors.click, 
      onEnter: (_) { if (!disabled) setState(() => _isHovered = true); }, 
      onExit: (_) { if (!disabled) setState(() => _isHovered = false); },
      child: Tooltip(
        message: widget.tooltip ?? '', waitDuration: const Duration(milliseconds: 500),
        child: GestureDetector(
          onTap: widget.onPressed, onSecondaryTap: widget.onSecondaryPressed,
          child: Listener(
            onPointerSignal: (pointerSignal) { if (pointerSignal is PointerScrollEvent && widget.onScroll != null) widget.onScroll!(pointerSignal.scrollDelta.dy); },
            child: AnimatedScale(
              scale: _isHovered && !disabled ? 1.15 : 1.0, 
              duration: const Duration(milliseconds: 200), curve: Curves.easeOutBack, 
              child: Container(padding: const EdgeInsets.all(8), color: Colors.transparent, child: Icon(widget.icon, size: widget.size, color: color)),
            ),
          ),
        ),
      ),
    );
  }
}

class _PlayPauseButton extends StatefulWidget {
  final AudioProvider audioProvider;
  const _PlayPauseButton({required this.audioProvider});

  @override
  State<_PlayPauseButton> createState() => _PlayPauseButtonState();
}

class _PlayPauseButtonState extends State<_PlayPauseButton> {
  bool _isHovered = false;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final audioProvider = widget.audioProvider;

    return MouseRegion(
      cursor: audioProvider.isLoading ? SystemMouseCursors.basic : SystemMouseCursors.click,
      onEnter: (_) => setState(() => _isHovered = true),
      onExit: (_) => setState(() => _isHovered = false),
      child: GestureDetector(
        onTap: audioProvider.isLoading ? null : audioProvider.togglePlay,
        child: AnimatedScale(
          scale: _isHovered ? 1.1 : 1.0,
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOutBack,
          child: Container(
            width: 48, height: 48,
            decoration: BoxDecoration(shape: BoxShape.circle, color: theme.colorScheme.onSurface.withAlpha(15)),
            child: Center(
              child: audioProvider.isLoading
                  ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2.5))
                  : Padding(
                      padding: EdgeInsets.only(left: audioProvider.isPlaying ? 0 : 4),
                      child: Icon(audioProvider.isPlaying ? CupertinoIcons.pause_fill : CupertinoIcons.play_fill, size: 26, color: theme.colorScheme.onSurface),
                    ),
            ),
          ),
        ),
      ),
    );
  }
}
