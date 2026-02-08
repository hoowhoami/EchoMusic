import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import 'dart:ui';
import 'package:audio_video_progress_bar/audio_video_progress_bar.dart';
import 'package:echomusic/providers/audio_provider.dart';
import 'package:echomusic/providers/lyric_provider.dart';
import '../widgets/cover_image.dart';

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
  
  late LyricProvider _lyricProvider;
  late AudioProvider _audioProvider;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        context.read<LyricProvider>().setPageOpen(true);
      }
    });
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _lyricProvider = Provider.of<LyricProvider>(context, listen: false);
    _audioProvider = Provider.of<AudioProvider>(context, listen: false);
  }

  @override
  void dispose() {
    _lyricProvider.setPageOpen(false);
    _scrollController.dispose();
    super.dispose();
  }

  void _scrollToCurrent(double lineHeight, int index, {bool force = false}) {
    if (!_scrollController.hasClients || index < 0) return;
    final targetOffset = index * lineHeight;
    if (force) {
      _scrollController.jumpTo(targetOffset.clamp(0, _scrollController.position.maxScrollExtent));
    } else if (_isAutoScrolling) {
      _scrollController.animateTo(
        targetOffset.clamp(0, _scrollController.position.maxScrollExtent),
        duration: const Duration(milliseconds: 600),
        curve: Curves.fastEaseInToSlowEaseOut,
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final audioProvider = context.watch<AudioProvider>();
    final lyricProvider = context.watch<LyricProvider>();
    final song = audioProvider.currentSong;

    if (song == null) return const Scaffold(backgroundColor: Colors.black);

    if (_lastSongHash != song.hash) {
      _lastSongHash = song.hash;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) audioProvider.fetchLyrics();
      });
    }

    final bool isDualLine = lyricProvider.showTranslation || lyricProvider.showRomanization;
    final double lineHeight = isDualLine ? 100.0 : 70.0;
    
    bool forceSync = false;
    if (_lastMode != lyricProvider.lyricsMode || _lastLineHeight != lineHeight) {
      _lastMode = lyricProvider.lyricsMode;
      _lastLineHeight = lineHeight;
      _isAutoScrolling = true; 
      forceSync = true;
    }

    WidgetsBinding.instance.addPostFrameCallback((_) {
      _scrollToCurrent(lineHeight, lyricProvider.currentLineIndex, force: forceSync);
    });

    return Scaffold(
      backgroundColor: Colors.black,
      body: Stack(
        children: [
          Positioned.fill(
            child: ImageFiltered(
              imageFilter: ImageFilter.blur(sigmaX: 80, sigmaY: 80),
              child: Opacity(opacity: 0.4, child: CoverImage(url: song.cover, borderRadius: 0, showShadow: false, fit: BoxFit.cover, size: 800)),
            ),
          ),
          Positioned.fill(
            child: Container(
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topCenter,
                  end: Alignment.bottomCenter,
                  colors: [Colors.black.withAlpha(200), Colors.transparent, Colors.black.withAlpha(220)],
                  stops: const [0.0, 0.5, 1.0],
                ),
              ),
            ),
          ),

          SafeArea(
            child: Column(
              children: [
                _buildTopBar(context, lyricProvider, song),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 60),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.center,
                      children: [
                        Expanded(flex: 5, child: _buildInfoSection(context, song)),
                        const SizedBox(width: 40),
                        Expanded(flex: 7, child: _buildLyricSection(lyricProvider, audioProvider, theme, lineHeight)),
                      ],
                    ),
                  ),
                ),
                _buildBottomSection(context, audioProvider, theme),
                const SizedBox(height: 32),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildTopBar(BuildContext context, LyricProvider lyricProvider, dynamic song) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 32, 24, 0),
      child: Row(
        children: [
          _buildIconBtn(Icons.keyboard_arrow_down_rounded, 36, () => Navigator.pop(context)),
          const Spacer(),
          _buildLyricsModeSwitcher(lyricProvider),
        ],
      ),
    );
  }

  Widget _buildLyricsModeSwitcher(LyricProvider lyricProvider) {
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

  Widget _buildInfoSection(BuildContext context, dynamic song) {
    final screenHeight = MediaQuery.of(context).size.height;
    final coverSize = (screenHeight * 0.38).clamp(240.0, 400.0);
    return Column(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        Hero(tag: 'player_cover', child: Container(width: coverSize, height: coverSize, decoration: BoxDecoration(borderRadius: BorderRadius.circular(24), boxShadow: [BoxShadow(color: Colors.black.withAlpha(150), blurRadius: 50, offset: const Offset(0, 20), spreadRadius: -10)]), child: CoverImage(url: song.cover, width: coverSize, height: coverSize, borderRadius: 24, size: 800, showShadow: false))),
        const SizedBox(height: 48),
        Text(song.name, style: const TextStyle(fontSize: 32, fontWeight: FontWeight.w900, color: Colors.white, letterSpacing: -1, height: 1.2), textAlign: TextAlign.center, maxLines: 2, overflow: TextOverflow.ellipsis),
        const SizedBox(height: 12),
        Text(song.singerName, style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600, color: Colors.white.withAlpha(160), letterSpacing: 0.5), textAlign: TextAlign.center),
      ],
    );
  }

  Widget _buildLyricSection(LyricProvider lyricProvider, AudioProvider audioProvider, ThemeData theme, double lineHeight) {
    if (lyricProvider.lyrics.isEmpty) return _buildEmptyState(lyricProvider.tips);
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
                } else if (lyricProvider.showRomanization) secondary = line.romanized;
                return Container(height: lineHeight, padding: const EdgeInsets.symmetric(horizontal: 16), alignment: Alignment.center, child: _LyricLineWidget(line: line, secondaryText: secondary, isCurrent: lyricProvider.currentLineIndex == index, theme: theme, maxWidth: constraints.maxWidth - 32, onTap: () { audioProvider.player.seek(Duration(milliseconds: line.startTime)); setState(() => _isAutoScrolling = true); }));
              },
            ),
          ),
        );
      },
    );
  }

  Widget _buildBottomSection(BuildContext context, AudioProvider audioProvider, ThemeData theme) {
    return Container(
      width: 500,
      padding: const EdgeInsets.symmetric(horizontal: 40),
      child: Column(
        children: [
          StreamBuilder<Duration>(
            stream: audioProvider.player.stream.position,
            builder: (context, snapshot) {
              final position = snapshot.data ?? Duration.zero;
              final total = audioProvider.player.state.duration;
              return Column(
                children: [
                  MouseRegion(
                    cursor: SystemMouseCursors.click,
                    child: ProgressBar(
                      progress: position, total: total, barHeight: 4, baseBarColor: Colors.white.withAlpha(30), progressBarColor: theme.colorScheme.primary, thumbColor: Colors.white, thumbRadius: 6, thumbGlowRadius: 0, timeLabelLocation: TimeLabelLocation.none,
                      onSeek: (duration) => audioProvider.player.seek(duration),
                    ),
                  ),
                  const SizedBox(height: 10),
                  Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [_buildTimeText(position), _buildTimeText(total)]),
                ],
              );
            },
          ),
          const SizedBox(height: 16),
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
        ],
      ),
    );
  }

  Widget _buildTimeText(Duration d) {
    String twoDigits(int n) => n.toString().padLeft(2, "0");
    return Text("${twoDigits(d.inMinutes.remainder(60))}:${twoDigits(d.inSeconds.remainder(60))}", style: const TextStyle(color: Colors.white38, fontSize: 11, fontWeight: FontWeight.w700, fontFamily: 'monospace'));
  }

  Widget _buildIconBtn(IconData icon, double size, VoidCallback onTap) => MouseRegion(cursor: SystemMouseCursors.click, child: IconButton(icon: Icon(icon, size: size, color: Colors.white.withAlpha(180)), onPressed: onTap, splashRadius: 28));

  Widget _buildPlayBtn(AudioProvider audioProvider) {
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        onTap: audioProvider.isLoading ? null : audioProvider.togglePlay,
        child: Container(
          width: 64, height: 64,
          decoration: BoxDecoration(shape: BoxShape.circle, color: Colors.white.withAlpha(20), border: Border.all(color: Colors.white.withAlpha(20), width: 1.5)),
          child: Center(
            child: audioProvider.isLoading
                ? const SizedBox(width: 24, height: 24, child: CircularProgressIndicator(strokeWidth: 2.5, color: Colors.white70))
                : Padding(
                    padding: EdgeInsets.only(left: audioProvider.isPlaying ? 0 : 4),
                    child: Icon(audioProvider.isPlaying ? CupertinoIcons.pause_fill : CupertinoIcons.play_fill, size: 32, color: Colors.white),
                  ),
          ),
        ),
      ),
    );
  }

  Widget _buildEmptyState(String tips) => Center(child: Column(mainAxisSize: MainAxisSize.min, children: [Icon(Icons.music_note_rounded, size: 64, color: Colors.white.withAlpha(10)), const SizedBox(height: 20), Text(tips, style: TextStyle(color: Colors.white38, fontSize: 18, fontWeight: FontWeight.w700, letterSpacing: 1))]));
}

class _LyricLineWidget extends StatelessWidget {
  final LyricLine line;
  final String? secondaryText;
  final bool isCurrent;
  final ThemeData theme;
  final double maxWidth;
  final VoidCallback onTap;

  const _LyricLineWidget({required this.line, this.secondaryText, required this.isCurrent, required this.theme, required this.maxWidth, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      hoverColor: Colors.transparent,
      splashColor: Colors.transparent,
      child: Opacity(
        opacity: isCurrent ? 1.0 : 0.3,
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
                        return TextSpan(
                          text: char.text,
                          style: TextStyle(
                            fontSize: isCurrent ? 26 : 20,
                            fontWeight: FontWeight.w900,
                            color: char.highlighted ? theme.colorScheme.primary : Colors.white,
                            letterSpacing: 0.5,
                            height: 1.3,
                            shadows: char.highlighted ? [Shadow(color: theme.colorScheme.primary.withAlpha(150), blurRadius: 15)] : null,
                          ),
                        );
                      }).toList(),
                    ),
                  ),
                ),
                if (secondaryText != null && secondaryText!.isNotEmpty) ...[
                  const SizedBox(height: 6),
                  Container(constraints: BoxConstraints(maxWidth: maxWidth), child: Text(secondaryText!, textAlign: TextAlign.center, softWrap: true, maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: isCurrent ? 14 : 12, fontWeight: FontWeight.w600, color: Colors.white.withAlpha(isCurrent ? 160 : 120), height: 1.2))),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}
