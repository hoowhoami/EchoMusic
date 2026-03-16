import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';
import 'package:window_manager/window_manager.dart';
import 'package:audio_video_progress_bar/audio_video_progress_bar.dart';
import 'package:echomusic/providers/audio_provider.dart';
import 'package:echomusic/providers/lyric_provider.dart';
import '../widgets/cover_image.dart';
import '../widgets/custom_toast.dart';
import '../widgets/windows_caption_controls.dart';

class LyricPage extends StatefulWidget {
  const LyricPage({super.key});

  @override
  State<LyricPage> createState() => _LyricPageState();
}

class _LyricPageState extends State<LyricPage> {
  final ScrollController _scrollController = ScrollController();
  bool _isAutoScrolling = true;
  LyricsMode? _lastMode;
  double _lastLineHeight = 0;
  String? _lastSongHash;
  int _lastScrolledIndex = -1;
  
  late LyricProvider _lyricProvider;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        final lyricProvider = context.read<LyricProvider>();
        final audioProvider = context.read<AudioProvider>();
        lyricProvider.setPageOpen(true);
        // Sync highlighting immediately when page opens
        lyricProvider.updateHighlight(audioProvider.effectivePosition);
      }
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _lyricProvider = Provider.of<LyricProvider>(context, listen: false);
  }

  @override
  void dispose() {
    _lyricProvider.setPageOpen(false);
    _scrollController.dispose();
    super.dispose();
  }

  void _scrollToCurrent(double lineHeight, int index, {bool force = false}) {
    if (!_scrollController.hasClients || index < 0) return;
    final targetOffset = (index * lineHeight)
        .clamp(0.0, _scrollController.position.maxScrollExtent);
    if (force) {
      _scrollController.jumpTo(targetOffset);
    } else if (_isAutoScrolling) {
      final distance = (targetOffset - _scrollController.offset).abs();
      final normalizedDistance =
          lineHeight <= 0 ? 1.0 : (distance / lineHeight).clamp(1.0, 3.0);
      final duration = Duration(
        milliseconds: (420 + normalizedDistance * 100).round(),
      );

      _scrollController.animateTo(
        targetOffset,
        duration: duration,
        curve: Curves.easeInOutCubic,
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final audioProvider = context.watch<AudioProvider>();
    final lyricProvider = context.read<LyricProvider>();
    final song = audioProvider.currentSong;

    if (song == null) return const Scaffold(backgroundColor: Colors.black);

    if (_lastSongHash != song.hash) {
      _lastSongHash = song.hash;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) audioProvider.fetchLyrics();
      });
    }

    return Focus(
      autofocus: true,
      onKeyEvent: (_, event) {
        if (event is KeyDownEvent && event.logicalKey == LogicalKeyboardKey.escape) {
          Navigator.pop(context);
          return KeyEventResult.handled;
        }
        return KeyEventResult.ignored;
      },
      child: Scaffold(
        backgroundColor: Colors.black,
        body: Stack(
          children: [
            // Background Image and Gradient
            Positioned.fill(
              child: Opacity(
                opacity: 0.15,
                child: CoverImage(url: song.cover, borderRadius: 0, showShadow: false, fit: BoxFit.cover, size: 400),
              ),
            ),
            Positioned.fill(
              child: Container(
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    begin: Alignment.topCenter,
                    end: Alignment.bottomCenter,
                    colors: [Colors.black.withAlpha(200), Colors.black.withAlpha(100), Colors.black.withAlpha(220)],
                    stops: const [0.0, 0.5, 1.0],
                  ),
                ),
              ),
            ),

            // Main Content
            Column(
              children: [
                // Top draggable area (Height 48)
                DragToMoveArea(
                  child: const SizedBox(
                    height: 48,
                    width: double.infinity,
                  ),
                ),
                // Header section (Interactive buttons row)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 24),
                  child: SizedBox(
                    height: 48,
                    child: Row(
                      children: [
                        _buildIconBtn(Icons.keyboard_arrow_down_rounded, 36, () => Navigator.pop(context)),
                        const Spacer(),
                        const _LyricsModeSwitcherWidget(),
                        const SizedBox(width: 8),
                        const _CopyLyricsButton(),
                      ],
                    ),
                  ),
                ),

                // Core content
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 60),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.center,
                      children: [
                        Expanded(
                          flex: 5,
                          child: _buildInfoSection(context, song, lyricProvider: lyricProvider),
                        ),
                        const SizedBox(width: 40),
                        Expanded(
                          flex: 7,
                          child: RepaintBoundary(child: _buildLyricSection(audioProvider, theme)),
                        ),
                      ],
                    ),
                  ),
                ),
                RepaintBoundary(child: _buildBottomSection(context, audioProvider, theme)),
                const SizedBox(height: 32),
              ],
            ),

            // Windows Controls
            if (!Platform.isMacOS)
              const Positioned(
                top: 0,
                right: 0,
                child: SizedBox(
                  height: WindowsCaptionControls.height,
                  child: WindowsCaptionControls(),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _buildInfoSection(
    BuildContext context,
    dynamic song, {
    required LyricProvider lyricProvider,
  }) {
    final screenHeight = MediaQuery.of(context).size.height;
    final coverSize = (screenHeight * 0.38).clamp(240.0, 400.0);
    final fontScale = context.watch<LyricProvider>().fontScale;
    return Column(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        Hero(tag: 'player_cover', child: Container(width: coverSize, height: coverSize, decoration: BoxDecoration(borderRadius: BorderRadius.circular(24), boxShadow: [BoxShadow(color: Colors.black.withAlpha(150), blurRadius: 50, offset: const Offset(0, 20), spreadRadius: -10)]), child: CoverImage(url: song.cover, width: coverSize, height: coverSize, borderRadius: 24, size: 800, showShadow: false))),
        const SizedBox(height: 48),
        Text(
          song.name,
          style: TextStyle(
            fontSize: 32 * fontScale,
            fontWeight: FontWeight.w900,
            color: Colors.white,
            letterSpacing: -1,
            height: 1.2,
          ),
          textAlign: TextAlign.center,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        const SizedBox(height: 12),
        Text(
          song.singerName,
          style: TextStyle(
            fontSize: 18 * fontScale,
            fontWeight: FontWeight.w600,
            color: Colors.white.withAlpha(160),
            letterSpacing: 0.5,
          ),
          textAlign: TextAlign.center,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
        ),
        const SizedBox(height: 18),
        _buildFontScaleControls(context, lyricProvider),
      ],
    );
  }

  Widget _buildFontScaleControls(
    BuildContext context,
    LyricProvider lyricProvider,
  ) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        Selector<LyricProvider, double>(
          selector: (_, provider) => provider.fontScale,
          builder: (_, fontScale, __) => _buildScaleButton(
            context,
            icon: Icons.text_decrease_rounded,
            tooltip: '字体减小',
            onPressed: () {
              lyricProvider.updateFontScale(fontScale - 0.1);
            },
          ),
        ),
        const SizedBox(width: 16),
        Selector<LyricProvider, double>(
          selector: (_, provider) => provider.fontScale,
          builder: (_, fontScale, __) => _buildScaleButton(
            context,
            icon: Icons.text_increase_rounded,
            tooltip: '字体增大',
            onPressed: () {
              lyricProvider.updateFontScale(fontScale + 0.1);
            },
          ),
        ),
      ],
    );
  }

  Widget _buildScaleButton(
    BuildContext context, {
    required IconData icon,
    required String tooltip,
    required VoidCallback onPressed,
  }) {
    return Tooltip(
      message: tooltip,
      child: InkWell(
        onTap: onPressed,
        borderRadius: BorderRadius.circular(22),
        child: Container(
          width: 36,
          height: 36,
          decoration: BoxDecoration(
            color: Colors.white.withAlpha(15),
            borderRadius: BorderRadius.circular(22),
            border: Border.all(color: Colors.white.withAlpha(20), width: 1),
          ),
          child: Icon(icon, size: 18, color: Colors.white70),
        ),
      ),
    );
  }

  Widget _buildLyricSection(AudioProvider audioProvider, ThemeData theme) {
    return Consumer<LyricProvider>(
      builder: (context, lyricProvider, child) {
        if (lyricProvider.lyrics.isEmpty) return _buildEmptyState(lyricProvider.tips);

        final bool isDualLine = lyricProvider.showTranslation || lyricProvider.showRomanization;
        final double lineHeight =
            (isDualLine ? 100.0 : 70.0) * lyricProvider.fontScale;
        
        bool forceSync = false;
        if (_lastMode != lyricProvider.lyricsMode || _lastLineHeight != lineHeight) {
          _lastMode = lyricProvider.lyricsMode;
          _lastLineHeight = lineHeight;
          _isAutoScrolling = true; 
          forceSync = true;
        }

        // Only schedule a scroll callback when the active line actually changes
        // or a force-sync is needed. This avoids queuing redundant callbacks on
        // every character-highlight update (which fires ~every 300ms).
        final currentIndex = lyricProvider.currentLineIndex;
        if (currentIndex != _lastScrolledIndex || forceSync) {
          _lastScrolledIndex = currentIndex;
          WidgetsBinding.instance.addPostFrameCallback((_) {
            _scrollToCurrent(lineHeight, currentIndex, force: forceSync);
          });
        }

        return LayoutBuilder(
          builder: (context, constraints) {
            final double verticalPadding = constraints.maxHeight / 2 - lineHeight / 2;
            return NotificationListener<ScrollNotification>(
              onNotification: (notification) {
                if (notification is UserScrollNotification) {
                  setState(() => _isAutoScrolling = false);
                  Future.delayed(const Duration(seconds: 4), () { if (mounted) setState(() => _isAutoScrolling = true); });
                }
                return false;
              },
              child: ShaderMask(
                shaderCallback: (rect) => const LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Colors.transparent, Colors.black, Colors.black, Colors.transparent], stops: [0.0, 0.15, 0.85, 1.0]).createShader(rect),
                blendMode: BlendMode.dstIn,
                child: ScrollConfiguration(
                  behavior: ScrollConfiguration.of(context).copyWith(
                    scrollbars: false,
                  ),
                  child: ListView.builder(
                    controller: _scrollController,
                    itemCount: lyricProvider.lyrics.length,
                    itemExtent: lineHeight, 
                    physics: const BouncingScrollPhysics(),
                    padding: EdgeInsets.symmetric(vertical: verticalPadding),
                    itemBuilder: (context, index) {
                      final line = lyricProvider.lyrics[index];
                      String? secondary;
                      if (lyricProvider.showTranslation) {
                        secondary = line.translated;
                      } else if (lyricProvider.showRomanization) {
                        secondary = line.romanized;
                      }
                      return Container(height: lineHeight, padding: const EdgeInsets.symmetric(horizontal: 16), alignment: Alignment.center, child: _LyricLineWidget(line: line, secondaryText: secondary, isCurrent: lyricProvider.currentLineIndex == index, theme: theme, maxWidth: constraints.maxWidth - 32, fontScale: lyricProvider.fontScale, onTap: () { audioProvider.seek(Duration(milliseconds: line.startTime)); setState(() => _isAutoScrolling = true); }));
                    },
                  ),
                ),
              ),
            );
          },
        );
      },
    );
  }

  Widget _buildBottomSection(BuildContext context, AudioProvider audioProvider, ThemeData theme) {
    return Container(
      width: 560,
      padding: const EdgeInsets.symmetric(horizontal: 32),
      child: Column(
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              _buildIconBtn(CupertinoIcons.backward_fill, 24, audioProvider.previous),
              const SizedBox(width: 48),
              _buildPlayBtn(audioProvider),
              const SizedBox(width: 48),
              _buildIconBtn(CupertinoIcons.forward_fill, 24, audioProvider.next),
            ],
          ),
          const SizedBox(height: 14),
          StreamBuilder<PositionSnapshot>(
            stream: audioProvider.positionSnapshotStream,
            initialData: PositionSnapshot(audioProvider.effectivePosition, audioProvider.effectiveDuration),
            builder: (context, snapshot) {
              final snap = snapshot.data ?? PositionSnapshot(audioProvider.effectivePosition, audioProvider.effectiveDuration);
              return SizedBox(
                width: 420,
                child: Row(
                  children: [
                    SizedBox(width: 42, child: _buildTimeText(snap.position, alignRight: true)),
                    const SizedBox(width: 12),
                    Expanded(
                      child: MouseRegion(
                        cursor: SystemMouseCursors.click,
                        child: ProgressBar(
                          progress: snap.position,
                          total: snap.duration,
                          barHeight: 4,
                          baseBarColor: Colors.white.withAlpha(30),
                          progressBarColor: theme.colorScheme.primary,
                          thumbColor: Colors.white,
                          thumbRadius: 6,
                          thumbGlowRadius: 0,
                          timeLabelLocation: TimeLabelLocation.none,
                          onSeek: (duration) => audioProvider.seek(duration),
                          onDragStart: (_) => audioProvider.notifyDragStart(),
                          onDragEnd: () => audioProvider.notifyDragEnd(),
                        ),
                      ),
                    ),
                    const SizedBox(width: 12),
                    SizedBox(width: 42, child: _buildTimeText(snap.duration)),
                  ],
                ),
              );
            },
          ),
        ],
      ),
    );
  }

  Widget _buildTimeText(Duration d, {bool alignRight = false}) {
    String twoDigits(int n) => n.toString().padLeft(2, "0");
    return Align(
      alignment: alignRight ? Alignment.centerRight : Alignment.centerLeft,
      child: Text(
        "${twoDigits(d.inMinutes.remainder(60))}:${twoDigits(d.inSeconds.remainder(60))}",
        style: const TextStyle(
          color: Colors.white38,
          fontSize: 11,
          fontWeight: FontWeight.w700,
          fontFamily: 'monospace',
        ),
      ),
    );
  }

  Widget _buildIconBtn(IconData icon, double size, VoidCallback onTap) => MouseRegion(cursor: SystemMouseCursors.click, child: IconButton(icon: Icon(icon, size: size, color: Colors.white.withAlpha(180)), onPressed: onTap, splashRadius: 28));

  Widget _buildPlayBtn(AudioProvider audioProvider) {
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        onTap: audioProvider.isLoading ? null : audioProvider.togglePlay,
        child: Container(
          width: 54,
          height: 54,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: Colors.white.withAlpha(20),
            border: Border.all(color: Colors.white.withAlpha(20), width: 1.4),
          ),
          child: Center(
            child: audioProvider.isLoading
                ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2.2, color: Colors.white70))
                : Icon(audioProvider.isPlaying ? CupertinoIcons.pause_fill : CupertinoIcons.play_fill, size: 26, color: Colors.white),
          ),
        ),
      ),
    );
  }

  Widget _buildEmptyState(String tips) => Center(child: Column(mainAxisSize: MainAxisSize.min, children: [Icon(Icons.music_note_rounded, size: 64, color: Colors.white.withAlpha(10)), const SizedBox(height: 20), Text(tips, style: TextStyle(color: Colors.white38, fontSize: 18, fontWeight: FontWeight.w700, letterSpacing: 1))]));
}

class _CopyLyricsButton extends StatelessWidget {
  const _CopyLyricsButton();

  @override
  Widget build(BuildContext context) {
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        onTap: () {
          final lyrics = context.read<LyricProvider>().lyrics;
          if (lyrics.isEmpty) return;
          final text = lyrics.map((line) => line.text).join('\n');
          Clipboard.setData(ClipboardData(text: text));
          CustomToast.success(context, '歌词已复制');
        },
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 10),
          decoration: BoxDecoration(
            color: Colors.white.withAlpha(15),
            borderRadius: BorderRadius.circular(24),
            border: Border.all(color: Colors.white.withAlpha(20), width: 1),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.copy_rounded, size: 16, color: Colors.white70),
              const SizedBox(width: 10),
              const Text('复制', style: TextStyle(color: Colors.white, fontSize: 13, fontWeight: FontWeight.w700, letterSpacing: 0.5)),
            ],
          ),
        ),
      ),
    );
  }
}

class _LyricsModeSwitcherWidget extends StatelessWidget {
  const _LyricsModeSwitcherWidget();

  @override
  Widget build(BuildContext context) {
    final lyricProvider = context.watch<LyricProvider>();
    String label = '标准';
    if (lyricProvider.lyricsMode == LyricsMode.translation) label = '翻译';
    if (lyricProvider.lyricsMode == LyricsMode.romanization) label = '音译';

    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        onTap: lyricProvider.toggleLyricsMode,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 10),
          decoration: BoxDecoration(color: Colors.white.withAlpha(15), borderRadius: BorderRadius.circular(24), border: Border.all(color: Colors.white.withAlpha(20), width: 1)),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Icon(Icons.translate_rounded, size: 16, color: Colors.white70),
              const SizedBox(width: 10),
              Text(label, style: const TextStyle(color: Colors.white, fontSize: 13, fontWeight: FontWeight.w700, letterSpacing: 0.5)),
            ],
          ),
        ),
      ),
    );
  }
}

class _LyricLineWidget extends StatelessWidget {
  static const Duration _lineTransitionDuration = Duration(milliseconds: 260);
  static const Duration _characterTransitionDuration = Duration(milliseconds: 180);

  final LyricLine line;
  final String? secondaryText;
  final bool isCurrent;
  final ThemeData theme;
  final double maxWidth;
  final double fontScale;
  final VoidCallback onTap;

  const _LyricLineWidget({required this.line, this.secondaryText, required this.isCurrent, required this.theme, required this.maxWidth, required this.fontScale, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final primaryFontSize = 25.0 * fontScale;
    final baseTextStyle = TextStyle(
      fontSize: primaryFontSize,
      fontWeight: FontWeight.w900,
      color: Colors.white,
      letterSpacing: 0.5,
      height: 1.3,
    );

    return InkWell(
      onTap: onTap,
      hoverColor: Colors.transparent,
      splashColor: Colors.transparent,
      child: AnimatedOpacity(
        duration: _lineTransitionDuration,
        curve: Curves.easeOutCubic,
        opacity: isCurrent ? 1.0 : 0.38,
        child: AnimatedSlide(
          duration: _lineTransitionDuration,
          curve: Curves.easeOutCubic,
          offset: isCurrent ? Offset.zero : const Offset(0, 0.06),
          child: AnimatedScale(
            duration: _lineTransitionDuration,
            curve: Curves.easeOutCubic,
            scale: isCurrent ? 1.0 : 0.9,
            alignment: Alignment.center,
            child: Container(
              width: maxWidth,
              alignment: Alignment.center,
              child: FittedBox(
                fit: BoxFit.scaleDown,
                alignment: Alignment.center,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.center,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Container(
                      constraints: BoxConstraints(maxWidth: maxWidth),
                      child: RichText(
                        textAlign: TextAlign.center,
                        softWrap: true,
                        text: TextSpan(
                          children: line.characters.map((char) {
                            final textStyle = baseTextStyle.copyWith(
                              color: char.highlighted
                                  ? theme.colorScheme.primary
                                  : Colors.white,
                              shadows: char.highlighted
                                  ? [
                                      Shadow(
                                        color: theme.colorScheme.primary
                                            .withAlpha(100),
                                        blurRadius: 8,
                                      ),
                                    ]
                                  : null,
                            );

                            return WidgetSpan(
                              alignment: PlaceholderAlignment.baseline,
                              baseline: TextBaseline.alphabetic,
                              child: AnimatedDefaultTextStyle(
                                duration: _characterTransitionDuration,
                                curve: Curves.easeOutCubic,
                                style: textStyle,
                                child: Text(char.text),
                              ),
                            );
                          }).toList(),
                        ),
                      ),
                    ),
                    if (secondaryText != null && secondaryText!.isNotEmpty) ...[
                      const SizedBox(height: 6),
                      Container(
                        constraints: BoxConstraints(maxWidth: maxWidth),
                        child: AnimatedDefaultTextStyle(
                          duration: _lineTransitionDuration,
                          curve: Curves.easeOutCubic,
                          style: TextStyle(
                            fontSize: (isCurrent ? 14 : 13) * fontScale,
                            fontWeight: FontWeight.w600,
                            color: Colors.white.withAlpha(isCurrent ? 160 : 120),
                            height: 1.2,
                          ),
                          child: Text(
                            secondaryText!,
                            textAlign: TextAlign.center,
                            softWrap: true,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
