import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter/gestures.dart';
import 'package:provider/provider.dart';
import 'package:audio_video_progress_bar/audio_video_progress_bar.dart';
import '../../theme/app_theme.dart';
import 'package:echomusic/providers/audio_provider.dart';
import 'package:echomusic/providers/persistence_provider.dart';
import 'package:echomusic/providers/user_provider.dart';
import '../../utils/constants.dart';
import '../screens/lyric_page.dart';
import 'cover_image.dart';
import 'queue_drawer.dart';
import 'song_detail_dialog.dart';

class PlayerBar extends StatelessWidget {
  const PlayerBar({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final modernTheme = theme.extension<AppModernTheme>();

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
          const Padding(
            padding: EdgeInsets.symmetric(horizontal: 24),
            child: _PlayerMainContent(),
          ),
          Positioned(
            top: -10,
            left: 0,
            right: 0,
            child: const _PlayerProgressBar(),
          ),
        ],
      ),
    );
  }
}

class _PlayerProgressBar extends StatelessWidget {
  const _PlayerProgressBar();

  @override
  Widget build(BuildContext context) {
    return Selector<AudioProvider, bool>(
      selector: (_, p) => p.currentSong != null,
      builder: (context, hasSong, child) {
        if (!hasSong) return const SizedBox.shrink();
        
        return Padding(
          padding: const EdgeInsets.symmetric(horizontal: 6),
          child: LayoutBuilder(
            builder: (context, constraints) {
              return RepaintBoundary(
                child: MouseRegion(
                  cursor: SystemMouseCursors.click,
                  child: Container(
                    height: 20,
                    color: Colors.transparent,
                    child: Stack(
                      alignment: Alignment.centerLeft,
                      children: [
                        // Climax Range Markers
                        const _ClimaxRangeLines(),
                        // Real Main Progress Bar
                        const _ProgressBarWidget(),
                        // Boundary markers
                        const _ClimaxBoundaryMarkers(),
                      ],
                    ),
                  ),
                ),
              );
            }
          ),
        );
      },
    );
  }
}

class _ProgressBarWidget extends StatefulWidget {
  const _ProgressBarWidget();

  @override
  State<_ProgressBarWidget> createState() => _ProgressBarWidgetState();
}

class _ProgressBarWidgetState extends State<_ProgressBarWidget> {
  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final accentColor = theme.colorScheme.primary;

    return Consumer<AudioProvider>(
      builder: (context, audioProvider, child) {
        return StreamBuilder<PositionSnapshot>(
          stream: audioProvider.positionSnapshotStream,
          initialData: PositionSnapshot(audioProvider.effectivePosition, audioProvider.effectiveDuration),
          builder: (context, snapshot) {
            final snap = snapshot.data ?? PositionSnapshot(audioProvider.effectivePosition, audioProvider.effectiveDuration);
            return ProgressBar(
              progress: snap.position,
              total: snap.duration,
              barHeight: 4.0,
              baseBarColor: theme.colorScheme.onSurface.withAlpha(20),
              progressBarColor: accentColor,
              thumbColor: accentColor,
              thumbRadius: 7.0,
              thumbGlowRadius: 15.0,
              onSeek: (duration) => audioProvider.seek(duration),
              onDragStart: (_) => audioProvider.notifyDragStart(),
              onDragEnd: () => audioProvider.notifyDragEnd(),
              timeLabelLocation: TimeLabelLocation.none,
            );
          },
        );
      },
    );
  }
}

class _ClimaxRangeLines extends StatelessWidget {
  const _ClimaxRangeLines();

  @override
  Widget build(BuildContext context) {
    return Selector<AudioProvider, Map<double, double>>(
      selector: (_, p) => p.climaxMarks,
      builder: (context, marks, child) {
        if (marks.isEmpty) return const SizedBox.shrink();
        return LayoutBuilder(builder: (context, constraints) {
          return Stack(
            children: marks.entries.map((entry) {
              final start = entry.key;
              final end = entry.value;
              return Positioned(
                left: constraints.maxWidth * start,
                top: 0,
                bottom: 0,
                child: Center(
                  child: Container(
                    width: (end - start) * constraints.maxWidth,
                    height: 3,
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(1.5),
                      gradient: LinearGradient(
                        colors: [
                          const Color(0xFFFFAB40).withAlpha(0),
                          const Color(0xFFFFAB40).withAlpha(120),
                          const Color(0xFFFFE082).withAlpha(180),
                          const Color(0xFFFFAB40).withAlpha(120),
                          const Color(0xFFFFAB40).withAlpha(0),
                        ],
                        stops: const [0.0, 0.2, 0.5, 0.8, 1.0],
                      ),
                    ),
                  ),
                ),
              );
            }).toList(),
          );
        });
      },
    );
  }
}

class _ClimaxBoundaryMarkers extends StatelessWidget {
  const _ClimaxBoundaryMarkers();

  @override
  Widget build(BuildContext context) {
    return Selector<AudioProvider, Map<double, double>>(
      selector: (_, p) => p.climaxMarks,
      builder: (context, marks, child) {
        if (marks.isEmpty) return const SizedBox.shrink();
        return LayoutBuilder(builder: (context, constraints) {
          return Stack(
            children: marks.entries.expand((entry) {
              final start = entry.key;
              final end = entry.value;
              return [
                Positioned(
                  left: constraints.maxWidth * start - 6,
                  top: 0,
                  bottom: 0,
                  child: const Center(child: _ClimaxMarker(isStart: true)),
                ),
                Positioned(
                  left: constraints.maxWidth * end - 6,
                  top: 0,
                  bottom: 0,
                  child: const Center(child: _ClimaxMarker(isStart: false)),
                ),
              ];
            }).toList(),
          );
        });
      },
    );
  }
}

class _PlayerMainContent extends StatelessWidget {
  const _PlayerMainContent();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final accentColor = theme.colorScheme.primary;

    return Selector<AudioProvider, bool>(
      selector: (_, p) => p.currentSong == null,
      builder: (context, isEmpty, child) {
        if (isEmpty) return _buildEmptyState(context);
        return _buildPlayerContent(context, theme, accentColor);
      },
    );
  }

  Widget _buildEmptyState(BuildContext context) {
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
              _PlayerIconButton(icon: CupertinoIcons.backward_fill, onPressed: null, size: 22),
              const SizedBox(width: 28),
              Container(
                width: 44, height: 44,
                decoration: BoxDecoration(shape: BoxShape.circle, color: theme.colorScheme.onSurface.withAlpha(5)),
                child: Center(child: Icon(CupertinoIcons.play_fill, size: 24, color: theme.disabledColor)),
              ),
              const SizedBox(width: 28),
              _PlayerIconButton(icon: CupertinoIcons.forward_fill, onPressed: null, size: 22),
            ],
          ),
        ),
        const SizedBox(width: 320),
      ],
    );
  }

  Widget _buildPlayerContent(BuildContext context, ThemeData theme, Color accentColor) {
    return Row(
      children: [
        // 1. Song Info
        const SizedBox(width: 380, child: _PlayerSongInfo()),

        // 2. Playback Controls
        Expanded(
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              _PlayerIconButton(icon: CupertinoIcons.backward_fill, onPressed: context.read<AudioProvider>().previous, size: 26, tooltip: '上一首'),
              const SizedBox(width: 24),
              const _PlayPauseButtonIsolated(),
              const SizedBox(width: 24),
              _PlayerIconButton(icon: CupertinoIcons.forward_fill, onPressed: context.read<AudioProvider>().next, size: 26, tooltip: '下一首'),
            ],
          ),
        ),

        // 3. Functional Buttons
        const SizedBox(width: 380, child: _PlayerRightActions()),
      ],
    );
  }
}

class _PlayerSongInfo extends StatelessWidget {
  const _PlayerSongInfo();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final accentColor = theme.colorScheme.primary;

    return Selector<AudioProvider, dynamic>(
      selector: (_, p) => p.currentSong,
      builder: (context, song, child) {
        if (song == null) return const SizedBox.shrink();

        return Row(
          children: [
            InkWell(
              onTap: () => Navigator.push(context, CupertinoPageRoute(builder: (_) => const LyricPage())),
              borderRadius: BorderRadius.circular(12),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Hero(
                    tag: 'player_cover',
                    child: CoverImage(url: song.cover, width: 52, height: 52, borderRadius: 8, size: 100, showShadow: true),
                  ),
                  const SizedBox(width: 14),
                  ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 140),
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(song.name, style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15), maxLines: 1, overflow: TextOverflow.ellipsis),
                        const SizedBox(height: 2),
                        Text(song.singerName, style: TextStyle(color: theme.colorScheme.onSurface.withAlpha(140), fontSize: 12, fontWeight: FontWeight.w600), maxLines: 1, overflow: TextOverflow.ellipsis),
                      ],
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            if (song.source == 'cloud')
              _PlayerIconButton(icon: CupertinoIcons.cloud_fill, size: 16, activeColor: accentColor, isSelected: true, onPressed: (){}, tooltip: '云盘歌曲'),
            const _FavoriteButton(),
            _PlayerIconButton(
              icon: CupertinoIcons.ellipsis,
              size: 20,
              tooltip: '歌曲详情',
              onPressed: () => SongDetailDialog.show(context, song),
            ),
          ],
        );
      },
    );
  }
}

class _FavoriteButton extends StatelessWidget {
  const _FavoriteButton();

  @override
  Widget build(BuildContext context) {
    final userProvider = context.watch<UserProvider>();
    
    return Selector2<AudioProvider, PersistenceProvider, ({dynamic song, bool isFav})>(
      selector: (_, a, p) => (
        song: a.currentSong,
        isFav: a.currentSong != null ? p.isFavorite(a.currentSong!) : false,
      ),
      builder: (context, data, child) {
        if (data.song == null || !userProvider.isAuthenticated) return const SizedBox.shrink();
        
        return _PlayerIconButton(
          icon: data.isFav ? CupertinoIcons.heart_fill : CupertinoIcons.heart,
          isSelected: data.isFav,
          activeColor: Colors.redAccent,
          onPressed: () => context.read<PersistenceProvider>().toggleFavorite(data.song, userProvider: userProvider),
          size: 20, tooltip: '收藏',
        );
      },
    );
  }
}

class _PlayPauseButtonIsolated extends StatelessWidget {
  const _PlayPauseButtonIsolated();

  @override
  Widget build(BuildContext context) {
    return Selector<AudioProvider, ({bool playing, bool loading})>(
      selector: (_, p) => (playing: p.isPlaying, loading: p.isLoading),
      builder: (context, state, child) {
        return _PlayPauseButton(isPlaying: state.playing, isLoading: state.loading);
      },
    );
  }
}

class _PlayerRightActions extends StatelessWidget {
  const _PlayerRightActions();

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.end,
      children: [
        const _PlaybackTimeInfo(),
        const SizedBox(width: 16),
        const _PlayModeButton(),
        const SizedBox(width: 12),
        const _PlaybackRateButton(),
        const SizedBox(width: 12),
        const _QualityButton(),
        const SizedBox(width: 12),
        const _VolumeButton(),
        const SizedBox(width: 12),
        const _QueueButton(),
      ],
    );
  }
}

class _PlaybackTimeInfo extends StatelessWidget {
  const _PlaybackTimeInfo();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Consumer<AudioProvider>(
      builder: (context, audioProvider, child) {
        return StreamBuilder<PositionSnapshot>(
          stream: audioProvider.positionSnapshotStream,
          initialData: PositionSnapshot(audioProvider.effectivePosition, audioProvider.effectiveDuration),
          builder: (context, snapshot) {
            final snap = snapshot.data ?? PositionSnapshot(audioProvider.effectivePosition, audioProvider.effectiveDuration);
            return Text(
              '${_formatDuration(snap.position)} / ${_formatDuration(snap.duration)}',
              style: TextStyle(fontSize: 11, fontFamily: 'monospace', color: theme.colorScheme.onSurface.withAlpha(120), fontWeight: FontWeight.w600),
            );
          },
        );
      },
    );
  }
  String _formatDuration(Duration duration) {
    String twoDigits(int n) => n.toString().padLeft(2, "0");
    return "${twoDigits(duration.inMinutes.remainder(60))}:${twoDigits(duration.inSeconds.remainder(60))}";
  }
}

class _PlayModeButton extends StatelessWidget {
  const _PlayModeButton();
  static final LayerLink _playModeLink = LayerLink();

  @override
  Widget build(BuildContext context) {
    return CompositedTransformTarget(
      link: _playModeLink,
      child: Selector<AudioProvider, String>(
        selector: (_, p) => p.playMode,
        builder: (context, mode, child) {
          IconData icon = CupertinoIcons.repeat;
          String tip = '列表循环';
          if (mode == 'repeat-once') { icon = CupertinoIcons.repeat_1; tip = '单曲循环'; }
          else if (mode == 'shuffle') { icon = CupertinoIcons.shuffle; tip = '随机播放'; }
          
          return _PlayerIconButton(
            icon: icon, isSelected: true, 
            onPressed: () => _showCustomPopup(context, _playModeLink, const _PlayModePopup(), width: 140, height: 180),
            size: 20, tooltip: tip,
          );
        },
      ),
    );
  }
}

class _PlaybackRateButton extends StatelessWidget {
  const _PlaybackRateButton();
  static final LayerLink _speedLink = LayerLink();

  @override
  Widget build(BuildContext context) {
    return CompositedTransformTarget(
      link: _speedLink,
      child: Selector<AudioProvider, double>(
        selector: (_, p) => p.playbackRate,
        builder: (context, rate, child) {
          return _PlayerIconButton(
            icon: CupertinoIcons.speedometer,
            isSelected: rate != 1.0,
            onPressed: () => _showCustomPopup(context, _speedLink, const _SpeedPopup(), width: 120, height: 340),
            size: 20, tooltip: '播放倍速',
          );
        },
      ),
    );
  }
}

class _QualityButton extends StatelessWidget {
  const _QualityButton();
  static final LayerLink _qualityLink = LayerLink();

  @override
  Widget build(BuildContext context) {
    return CompositedTransformTarget(
      link: _qualityLink,
      child: Selector<AudioProvider, dynamic>(
        selector: (_, p) => p.currentSong,
        builder: (context, song, child) {
          return _PlayerIconButton(
            icon: CupertinoIcons.waveform,
            onPressed: song?.source == 'cloud' ? null : () => _showCustomPopup(context, _qualityLink, const _QualityEffectPopup(), width: 180, height: 380),
            size: 20, tooltip: '音质选择',
            isSelected: true,
          );
        },
      ),
    );
  }
}

class _VolumeButton extends StatelessWidget {
  const _VolumeButton();
  static final LayerLink _volumeLink = LayerLink();

  @override
  Widget build(BuildContext context) {
    final audioProvider = context.read<AudioProvider>();
    return CompositedTransformTarget(
      link: _volumeLink,
      child: Selector<PersistenceProvider, double>(
        selector: (_, p) => p.volume,
        builder: (context, vol, child) {
          return _PlayerIconButton(
            icon: vol == 0 ? CupertinoIcons.speaker_slash_fill : (vol < 0.5 ? CupertinoIcons.speaker_1_fill : CupertinoIcons.speaker_2_fill),
            isSelected: vol > 0,
            onPressed: () => _showCustomPopup(context, _volumeLink, const _VolumePopup(), width: 50, height: 200),
            onScroll: (delta) {
              final newVol = (vol + (delta > 0 ? -0.05 : 0.05)).clamp(0.0, 1.0);
              audioProvider.setVolume(newVol);
            },
            size: 20, tooltip: '音量',
          );
        },
      ),
    );
  }
}

class _QueueButton extends StatelessWidget {
  const _QueueButton();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final accentColor = theme.colorScheme.primary;

    return Stack(
      clipBehavior: Clip.none,
      children: [
        _PlayerIconButton(icon: CupertinoIcons.list_bullet, onPressed: () => _showQueueDrawer(context), size: 22, tooltip: '播放队列'),
        Selector2<AudioProvider, PersistenceProvider, ({int count, bool show})>(
          selector: (_, a, p) => (
            count: a.playlist.length,
            show: p.settings['showPlaylistCount'] ?? true
          ),
          builder: (context, data, child) {
            if (!data.show) return const SizedBox.shrink();
            return Positioned(
              top: -2,
              right: -10,
              child: IgnorePointer(
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 0.5),
                  decoration: BoxDecoration(
                    color: accentColor,
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(color: theme.colorScheme.surface, width: 1.5),
                    boxShadow: [
                      BoxShadow(color: Colors.black.withAlpha(50), blurRadius: 4, offset: const Offset(0, 1)),
                    ],
                  ),
                  constraints: const BoxConstraints(minWidth: 16, minHeight: 16),
                  child: Center(
                    child: Text(
                      data.count > 99 ? '99+' : '${data.count}',
                      style: const TextStyle(
                        color: Colors.white,
                        fontSize: 8,
                        fontWeight: FontWeight.w900,
                        height: 1.1,
                      ),
                    ),
                  ),
                ),
              ),
            );
          },
        ),
      ],
    );
  }
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

void _showQueueDrawer(BuildContext context) {
  final theme = Theme.of(context);
  showGeneralDialog(
    context: context, barrierLabel: 'Queue', barrierDismissible: true,
    barrierColor: theme.colorScheme.scrim.withAlpha(20),
    transitionDuration: const Duration(milliseconds: 300),
    pageBuilder: (context, _, _) => Align(
      alignment: Alignment.centerRight,
      child: Padding(
        padding: const EdgeInsets.only(bottom: 96),
        child: Material(elevation: 20, borderRadius: const BorderRadius.horizontal(left: Radius.circular(16)), child: SizedBox(width: 380, child: const QueueDrawer())),
      ),
    ),
    transitionBuilder: (context, anim, _, child) => SlideTransition(
      position: Tween<Offset>(begin: const Offset(1, 0), end: Offset.zero).animate(CurvedAnimation(parent: anim, curve: Curves.easeOutCubic)),
      child: child,
    ),
  );
}

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
    final backgroundColor = theme.colorScheme.surface;
    final borderColor = theme.dividerTheme.color ?? theme.dividerColor.withAlpha(20);
    return Stack(
      clipBehavior: Clip.none,
      children: [
        Container(
          width: width, height: height,
          decoration: BoxDecoration(color: backgroundColor, borderRadius: BorderRadius.circular(16), border: Border.all(color: borderColor, width: 1), boxShadow: [BoxShadow(color: Colors.black.withAlpha(30), blurRadius: 20, offset: const Offset(0, 4))]),
          child: ClipRRect(borderRadius: BorderRadius.circular(16), child: child),
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
  final bool isPlaying;
  final bool isLoading;
  const _PlayPauseButton({required this.isPlaying, required this.isLoading});

  @override
  State<_PlayPauseButton> createState() => _PlayPauseButtonState();
}

class _PlayPauseButtonState extends State<_PlayPauseButton> {
  bool _isHovered = false;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return MouseRegion(
      cursor: widget.isLoading ? SystemMouseCursors.basic : SystemMouseCursors.click,
      onEnter: (_) => setState(() => _isHovered = true),
      onExit: (_) => setState(() => _isHovered = false),
      child: GestureDetector(
        onTap: widget.isLoading ? null : () => context.read<AudioProvider>().togglePlay(),
        child: AnimatedScale(
          scale: _isHovered ? 1.1 : 1.0,
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOutBack,
          child: Container(
            width: 48, height: 48,
            decoration: BoxDecoration(shape: BoxShape.circle, color: theme.colorScheme.onSurface.withAlpha(15)),
            child: Center(
              child: widget.isLoading
                  ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2.5))
                  : Padding(
                      padding: EdgeInsets.only(left: widget.isPlaying ? 0 : 4),
                      child: Icon(widget.isPlaying ? CupertinoIcons.pause_fill : CupertinoIcons.play_fill, size: 26, color: theme.colorScheme.onSurface),
                    ),
            ),
          ),
        ),
      ),
    );
  }
}

class _ClimaxMarker extends StatelessWidget {
  final bool isStart;
  const _ClimaxMarker({required this.isStart});

  @override
  Widget build(BuildContext context) {
    return IgnorePointer(
      child: Container(
        width: 6,
        height: 6,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: Colors.white,
          boxShadow: [
            BoxShadow(
              color: const Color(0xFFFF6D00).withAlpha(200),
              blurRadius: 4,
              spreadRadius: 1,
            ),
          ],
        ),
      ),
    );
  }
}
