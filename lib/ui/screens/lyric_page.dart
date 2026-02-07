import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import 'dart:ui';
import 'package:audio_video_progress_bar/audio_video_progress_bar.dart';
import '../../providers/audio_provider.dart';
import '../../providers/lyric_provider.dart';
import '../widgets/cover_image.dart';

class LyricPage extends StatefulWidget {
  const LyricPage({super.key});

  @override
  State<LyricPage> createState() => _LyricPageState();
}

class _LyricPageState extends State<LyricPage> {
  final ScrollController _scrollController = ScrollController();
  bool _isAutoScrolling = true;

  @override
  void dispose() {
    _scrollController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final audioProvider = context.watch<AudioProvider>();
    final lyricProvider = context.watch<LyricProvider>();
    final song = audioProvider.currentSong;

    if (song == null) return const Scaffold(backgroundColor: Colors.black);

    // Dynamic line height calculation
    final bool isDualLine = lyricProvider.lyricsMode != LyricsMode.none;
    final double lineHeight = isDualLine ? 84.0 : 56.0;

    // Auto-scroll logic with Precise Centering
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_isAutoScrolling && _scrollController.hasClients && lyricProvider.currentLineIndex >= 0) {
        // With padding equal to half the container height, targetOffset is simply index * lineHeight
        final targetOffset = lyricProvider.currentLineIndex * lineHeight;
        
        _scrollController.animateTo(
          targetOffset.clamp(0, _scrollController.position.maxScrollExtent),
          duration: const Duration(milliseconds: 600),
          curve: Curves.fastEaseInToSlowEaseOut,
        );
      }
    });

    return Scaffold(
      backgroundColor: Colors.black,
      body: Stack(
        children: [
          // Dynamic Background
          Positioned.fill(
            child: Opacity(
              opacity: 0.35,
              child: CoverImage(
                url: song.cover,
                borderRadius: 0,
                showShadow: false,
                fit: BoxFit.cover,
                size: 800,
              ),
            ),
          ),
          
          // Multi-layer Frosted Glass
          Positioned.fill(
            child: BackdropFilter(
              filter: ImageFilter.blur(sigmaX: 120, sigmaY: 120),
              child: Container(
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    begin: Alignment.topCenter,
                    end: Alignment.bottomCenter,
                    colors: [
                      Colors.black.withAlpha(200),
                      Colors.black.withAlpha(140),
                      Colors.black.withAlpha(220),
                    ],
                  ),
                ),
              ),
            ),
          ),

          SafeArea(
            child: Column(
              children: [
                // Top Bar
                Padding(
                  padding: const EdgeInsets.fromLTRB(40, 20, 40, 0),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.center,
                    children: [
                      IconButton(
                        icon: const Icon(Icons.keyboard_arrow_down_rounded, size: 28, color: Colors.white60),
                        onPressed: () => Navigator.pop(context),
                      ),
                      const Spacer(),
                      _buildTopAction(
                        icon: Icons.translate_rounded,
                        isActive: lyricProvider.lyricsMode != LyricsMode.none,
                        onPressed: lyricProvider.toggleLyricsMode,
                        label: _getLyricsModeLabel(lyricProvider.lyricsMode),
                      ),
                    ],
                  ),
                ),

                const SizedBox(height: 60),

                // Middle Section (Cover + Lyrics)
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 100),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.center,
                      children: [
                        // Left: Cover & Info
                        Expanded(
                          flex: 4,
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            crossAxisAlignment: CrossAxisAlignment.center,
                            children: [
                              Hero(
                                tag: 'player_cover',
                                child: Container(
                                  constraints: BoxConstraints(
                                    maxWidth: MediaQuery.of(context).size.height * 0.4,
                                    maxHeight: MediaQuery.of(context).size.height * 0.4,
                                  ),
                                  decoration: BoxDecoration(
                                    borderRadius: BorderRadius.circular(16),
                                    boxShadow: [
                                      BoxShadow(color: Colors.black.withAlpha(120), blurRadius: 40, offset: const Offset(0, 12)),
                                    ],
                                  ),
                                  child: CoverImage(
                                    url: song.cover,
                                    width: double.infinity,
                                    height: double.infinity,
                                    borderRadius: 16,
                                    size: 800,
                                    showShadow: false,
                                  ),
                                ),
                              ),
                              const SizedBox(height: 40),
                              _buildSongDetails(song, Colors.white),
                            ],
                          ),
                        ),

                        const SizedBox(width: 80),

                        // Right: Lyrics (Absolute Center Container)
                        Expanded(
                          flex: 6,
                          child: lyricProvider.lyrics.isEmpty
                              ? _buildEmptyState(lyricProvider.tips)
                              : LayoutBuilder(
                                  builder: (context, constraints) {
                                    // Padding to ensure current line is at the center of this container
                                    final double verticalPadding = constraints.maxHeight / 2 - lineHeight / 2;
                                    return _buildLyricList(lyricProvider, audioProvider, theme, verticalPadding, lineHeight);
                                  },
                                ),
                        ),
                      ],
                    ),
                  ),
                ),

                const SizedBox(height: 80),

                // Bottom: Controls
                Center(
                  child: _buildBottomControls(context, audioProvider, theme),
                ),
                const SizedBox(height: 20),
              ],
            ),
          ),
        ],
      ),
    );
  }

  String _getLyricsModeLabel(LyricsMode mode) {
    switch (mode) {
      case LyricsMode.translation: return '翻译';
      case LyricsMode.romanization: return '音译';
      case LyricsMode.none: return '纯净';
    }
  }

  Widget _buildTopAction({required IconData icon, required bool isActive, required VoidCallback onPressed, String? label}) {
    return InkWell(
      onTap: onPressed,
      borderRadius: BorderRadius.circular(20),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        decoration: BoxDecoration(
          color: isActive ? Colors.white.withAlpha(25) : Colors.white.withAlpha(8),
          borderRadius: BorderRadius.circular(20),
          border: Border.all(color: Colors.white.withAlpha(isActive ? 30 : 10)),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (label != null) ...[
              Text(label, style: TextStyle(color: isActive ? Colors.white : Colors.white60, fontSize: 12, fontWeight: FontWeight.w600)),
              const SizedBox(width: 8),
            ],
            Icon(icon, size: 16, color: isActive ? Colors.white : Colors.white60),
          ],
        ),
      ),
    );
  }

  Widget _buildSongDetails(dynamic song, Color color) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        Text(
          song.name,
          style: TextStyle(fontSize: 28, fontWeight: FontWeight.w900, color: color, letterSpacing: -0.5, height: 1.2),
          textAlign: TextAlign.center,
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
        ),
        const SizedBox(height: 12),
        Text(
          song.singerName,
          style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600, color: color.withAlpha(180)),
        ),
      ],
    );
  }

  Widget _buildLyricList(LyricProvider lyricProvider, AudioProvider audioProvider, ThemeData theme, double verticalPadding, double lineHeight) {
    return NotificationListener<ScrollNotification>(
      onNotification: (notification) {
        if (notification is UserScrollNotification) {
          setState(() => _isAutoScrolling = false);
          Future.delayed(const Duration(seconds: 4), () {
            if (mounted) setState(() => _isAutoScrolling = true);
          });
        }
        return false;
      },
      child: ShaderMask(
        shaderCallback: (rect) {
          return const LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [Colors.transparent, Colors.black, Colors.black, Colors.transparent],
            stops: [0.0, 0.2, 0.8, 1.0],
          ).createShader(rect);
        },
        blendMode: BlendMode.dstIn,
        child: ListView.builder(
          controller: _scrollController,
          itemCount: lyricProvider.lyrics.length,
          physics: const BouncingScrollPhysics(),
          padding: EdgeInsets.symmetric(vertical: verticalPadding),
          itemBuilder: (context, index) {
            final isCurrentLine = lyricProvider.currentLineIndex == index;
            final line = lyricProvider.lyrics[index];
            
            String? secondaryText;
            if (lyricProvider.showTranslation) secondaryText = line.translated;
            else if (lyricProvider.showRomanization) secondaryText = line.romanized;

            return AnimatedOpacity(
              duration: const Duration(milliseconds: 400),
              opacity: isCurrentLine ? 1.0 : 0.2,
              child: Container(
                height: lineHeight,
                alignment: Alignment.center,
                child: InkWell(
                  onTap: () {
                    audioProvider.player.seek(Duration(milliseconds: line.startTime));
                    setState(() => _isAutoScrolling = true);
                  },
                  hoverColor: Colors.transparent,
                  splashColor: Colors.transparent,
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      RichText(
                        textAlign: TextAlign.center,
                        text: TextSpan(
                          children: line.characters.map((char) {
                            return TextSpan(
                              text: char.text,
                              style: TextStyle(
                                fontSize: isCurrentLine ? 32 : 24,
                                fontWeight: FontWeight.w800,
                                color: char.highlighted ? theme.colorScheme.primary : (isCurrentLine ? Colors.white : Colors.white70),
                                letterSpacing: 0.8,
                                shadows: char.highlighted ? [Shadow(color: theme.colorScheme.primary.withAlpha(200), blurRadius: 20)] : null,
                              ),
                            );
                          }).toList(),
                        ),
                      ),
                      if (secondaryText != null && secondaryText.isNotEmpty) ...[
                        const SizedBox(height: 6),
                        Text(
                          secondaryText,
                          textAlign: TextAlign.center,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: isCurrentLine ? 18 : 16, fontWeight: FontWeight.w500, color: (isCurrentLine ? Colors.white : Colors.white54).withAlpha(160)),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
            );
          },
        ),
      ),
    );
  }

  Widget _buildBottomControls(BuildContext context, AudioProvider audioProvider, ThemeData theme) {
    return Container(
      width: 400,
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          StreamBuilder<Duration>(
            stream: audioProvider.player.positionStream,
            builder: (context, snapshot) {
              final position = snapshot.data ?? Duration.zero;
              final total = audioProvider.player.duration ?? Duration.zero;
              return Column(
                children: [
                  ProgressBar(
                    progress: position,
                    total: total,
                    barHeight: 4,
                    baseBarColor: Colors.white.withAlpha(25),
                    progressBarColor: theme.colorScheme.primary,
                    thumbColor: Colors.white,
                    thumbRadius: 6,
                    thumbGlowRadius: 0, // Removed big circle on drag
                    timeLabelLocation: TimeLabelLocation.none,
                    onSeek: (duration) => audioProvider.player.seek(duration),
                  ),
                  const SizedBox(height: 8),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Text(_formatDuration(position), style: const TextStyle(color: Colors.white38, fontSize: 11, fontWeight: FontWeight.w600, fontFamily: 'monospace')),
                      Text(_formatDuration(total), style: const TextStyle(color: Colors.white38, fontSize: 11, fontWeight: FontWeight.w600, fontFamily: 'monospace')),
                    ],
                  ),
                ],
              );
            },
          ),
          const SizedBox(height: 6), // Tightened gap
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              _buildControlBtn(icon: CupertinoIcons.backward_fill, size: 20, onPressed: audioProvider.previous),
              const SizedBox(width: 40),
              _buildPlayBtn(audioProvider, theme),
              const SizedBox(width: 40),
              _buildControlBtn(icon: CupertinoIcons.forward_fill, size: 20, onPressed: audioProvider.next),
            ],
          ),
        ],
      ),
    );
  }

  String _formatDuration(Duration duration) {
    String twoDigits(int n) => n.toString().padLeft(2, "0");
    return "${twoDigits(duration.inMinutes.remainder(60))}:${twoDigits(duration.inSeconds.remainder(60))}";
  }

  Widget _buildPlayBtn(AudioProvider audioProvider, ThemeData theme) {
    return GestureDetector(
      onTap: audioProvider.isLoading ? null : audioProvider.togglePlay,
      child: Container(
        width: 46,
        height: 46,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: Colors.white.withAlpha(18),
          border: Border.all(color: Colors.white.withAlpha(10)),
        ),
        child: Center(
          child: audioProvider.isLoading
              ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2.2, color: Colors.white60))
              : Icon(audioProvider.isPlaying ? CupertinoIcons.pause_fill : CupertinoIcons.play_fill, size: 22, color: Colors.white),
        ),
      ),
    );
  }

  Widget _buildControlBtn({required IconData icon, double size = 20, bool isActive = false, required VoidCallback onPressed}) {
    return IconButton(
      icon: Icon(icon, size: size, color: isActive ? Colors.white : Colors.white38),
      onPressed: onPressed,
      padding: EdgeInsets.zero,
      constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
    );
  }

  Widget _buildEmptyState(String tips) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.music_note_rounded, size: 48, color: Colors.white.withAlpha(8)),
          const SizedBox(height: 16),
          Text(tips, style: TextStyle(color: Colors.white.withAlpha(15), fontSize: 16, fontWeight: FontWeight.w700)),
        ],
      ),
    );
  }
}