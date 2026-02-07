import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import 'dart:ui';
import 'package:audio_video_progress_bar/audio_video_progress_bar.dart';
import 'package:just_audio/just_audio.dart';
import '../../providers/audio_provider.dart';
import '../../providers/lyric_provider.dart';
import '../../providers/persistence_provider.dart';
import '../../providers/user_provider.dart';
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
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final audioProvider = context.watch<AudioProvider>();
    final lyricProvider = context.watch<LyricProvider>();
    final song = audioProvider.currentSong;

    if (song == null) return const Scaffold(backgroundColor: Colors.black);

    // Auto-scroll logic
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_isAutoScrolling && _scrollController.hasClients && lyricProvider.currentLineIndex >= 0) {
        final screenHeight = MediaQuery.of(context).size.height;
        // Vertically center the highlighted line
        final targetOffset = (lyricProvider.currentLineIndex * 70.0) - (screenHeight * 0.5) + 35.0;
        
        _scrollController.animateTo(
          targetOffset.clamp(0, _scrollController.position.maxScrollExtent),
          duration: const Duration(milliseconds: 800),
          curve: Curves.fastEaseInToSlowEaseOut,
        );
      }
    });

    return Scaffold(
      backgroundColor: Colors.black,
      body: Stack(
        children: [
          // 1. Dynamic Background
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
          
          // 2. Multi-layer Frosted Glass
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

          // 3. Main Content
          SafeArea(
            child: Column(
              children: [
                // Top Bar
                Padding(
                  padding: const EdgeInsets.fromLTRB(40, 20, 40, 0),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.center,
                    children: [
                      Container(
                        width: 40,
                        height: 40,
                        alignment: Alignment.center,
                        child: IconButton(
                          icon: const Icon(Icons.keyboard_arrow_down_rounded, size: 28, color: Colors.white60),
                          onPressed: () => Navigator.pop(context),
                          padding: EdgeInsets.zero,
                          constraints: const BoxConstraints(),
                        ),
                      ),
                      const Spacer(),
                      _buildTopAction(
                        icon: Icons.translate_rounded,
                        isActive: lyricProvider.showTranslation,
                        onPressed: lyricProvider.toggleTranslation,
                      ),
                    ],
                  ),
                ),

                // Middle Section (Cover + Lyrics)
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 120),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.center,
                      children: [
                        // Left: Cover & Info
                        Expanded(
                          flex: 4,
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Center(
                                child: Hero(
                                  tag: 'player_cover',
                                  child: Container(
                                    constraints: const BoxConstraints(maxWidth: 260, maxHeight: 260),
                                    decoration: BoxDecoration(
                                      borderRadius: BorderRadius.circular(16),
                                      boxShadow: [
                                        BoxShadow(
                                          color: Colors.black.withAlpha(120),
                                          blurRadius: 40,
                                          offset: const Offset(0, 12),
                                        ),
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
                              ),
                              const SizedBox(height: 32),
                              _buildSongDetails(song, Colors.white),
                            ],
                          ),
                        ),

                        const SizedBox(width: 100),

                        // Right: Lyrics
                        Expanded(
                          flex: 6,
                          child: lyricProvider.lyrics.isEmpty
                              ? _buildEmptyState(lyricProvider.tips)
                              : _buildLyricList(lyricProvider, audioProvider, theme),
                        ),
                      ],
                    ),
                  ),
                ),

                // Bottom: Controls
                _buildBottomControls(context, audioProvider, theme),
                const SizedBox(height: 40),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildTopAction({required IconData icon, required bool isActive, required VoidCallback onPressed}) {
    return Container(
      decoration: BoxDecoration(
        color: isActive ? Colors.white.withAlpha(25) : Colors.white.withAlpha(8),
        borderRadius: BorderRadius.circular(8),
      ),
      child: IconButton(
        icon: Icon(icon, size: 16, color: isActive ? Colors.white : Colors.white60),
        onPressed: onPressed,
        constraints: const BoxConstraints(minWidth: 36, minHeight: 36),
        padding: EdgeInsets.zero,
      ),
    );
  }

  Widget _buildSongDetails(dynamic song, Color color) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          song.name,
          style: TextStyle(
            fontSize: 20,
            fontWeight: FontWeight.w900,
            color: color,
            letterSpacing: -0.4,
            height: 1.2,
          ),
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
        ),
        const SizedBox(height: 6),
        Text(
          song.singerName,
          style: TextStyle(
            fontSize: 14,
            fontWeight: FontWeight.w600,
            color: color.withAlpha(120),
          ),
        ),
        const SizedBox(height: 18),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
          decoration: BoxDecoration(
            color: Colors.white.withAlpha(12),
            borderRadius: BorderRadius.circular(6),
            border: Border.all(color: Colors.white.withAlpha(15)),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.album_rounded, size: 10, color: color.withAlpha(120)),
              const SizedBox(width: 6),
              Flexible(
                child: Text(
                  song.albumName,
                  style: TextStyle(color: color.withAlpha(120), fontSize: 11, fontWeight: FontWeight.w600),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildLyricList(LyricProvider lyricProvider, AudioProvider audioProvider, ThemeData theme) {
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
            stops: [0.0, 0.15, 0.85, 1.0],
          ).createShader(rect);
        },
        blendMode: BlendMode.dstIn,
        child: ListView.builder(
          controller: _scrollController,
          itemCount: lyricProvider.lyrics.length,
          physics: const BouncingScrollPhysics(),
          padding: const EdgeInsets.symmetric(vertical: 240),
          itemBuilder: (context, index) {
            final isCurrentLine = lyricProvider.currentLineIndex == index;
            final line = lyricProvider.lyrics[index];
            
            return AnimatedOpacity(
              duration: const Duration(milliseconds: 400),
              opacity: isCurrentLine ? 1.0 : 0.15,
              child: Container(
                margin: const EdgeInsets.symmetric(vertical: 10),
                child: InkWell(
                  onTap: () {
                    audioProvider.player.seek(Duration(milliseconds: line.startTime));
                    setState(() => _isAutoScrolling = true);
                  },
                  hoverColor: Colors.transparent,
                  splashColor: Colors.transparent,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.center,
                    children: [
                      RichText(
                        textAlign: TextAlign.center,
                        text: TextSpan(
                          children: line.characters.map((char) {
                            return TextSpan(
                              text: char.text,
                              style: TextStyle(
                                fontSize: isCurrentLine ? 22 : 18,
                                fontWeight: FontWeight.w900,
                                color: char.highlighted 
                                    ? theme.colorScheme.primary 
                                    : (isCurrentLine ? Colors.white : Colors.white70),
                                letterSpacing: -0.3,
                                height: 1.4,
                              ),
                            );
                          }).toList(),
                        ),
                      ),
                      if (lyricProvider.showTranslation && line.translated != null && line.translated!.isNotEmpty) ...[
                        const SizedBox(height: 4),
                        Text(
                          line.translated!,
                          textAlign: TextAlign.center,
                          style: TextStyle(
                            fontSize: isCurrentLine ? 14 : 12,
                            fontWeight: FontWeight.w600,
                            color: (isCurrentLine ? Colors.white : Colors.white54).withAlpha(140),
                            height: 1.3,
                          ),
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
      padding: const EdgeInsets.symmetric(horizontal: 80, vertical: 5),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          // Progress Bar
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 20),
            child: SizedBox(
              height: 20,
              child: Stack(
                alignment: Alignment.center,
                children: [
                  StreamBuilder<Duration>(
                    stream: audioProvider.player.positionStream,
                    builder: (context, snapshot) {
                      final position = snapshot.data ?? Duration.zero;
                      final total = audioProvider.player.duration ?? Duration.zero;
                      return ProgressBar(
                        progress: position,
                        total: total,
                        barHeight: 2,
                        baseBarColor: Colors.white.withAlpha(15),
                        progressBarColor: theme.colorScheme.primary,
                        thumbColor: Colors.white,
                        thumbRadius: 4,
                        timeLabelLocation: TimeLabelLocation.sides,
                        timeLabelTextStyle: const TextStyle(color: Colors.white38, fontSize: 10, fontWeight: FontWeight.w700, fontFamily: 'monospace'),
                        onSeek: (duration) => audioProvider.player.seek(duration),
                      );
                    },
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 12),
          // Buttons
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              _buildControlBtn(icon: CupertinoIcons.backward_fill, size: 24, onPressed: audioProvider.previous),
              const SizedBox(width: 44),
              _buildPlayBtn(audioProvider, theme),
              const SizedBox(width: 44),
              _buildControlBtn(icon: CupertinoIcons.forward_fill, size: 24, onPressed: audioProvider.next),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildPlayBtn(AudioProvider audioProvider, ThemeData theme) {
    return GestureDetector(
      onTap: audioProvider.isLoading ? null : audioProvider.togglePlay,
      child: Container(
        width: 50,
        height: 50,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          color: Colors.white.withAlpha(12),
          border: Border.all(color: Colors.white.withAlpha(8)),
        ),
        child: Center(
          child: audioProvider.isLoading
              ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white60))
              : Icon(
                  audioProvider.isPlaying ? CupertinoIcons.pause_fill : CupertinoIcons.play_fill,
                  size: 24,
                  color: Colors.white,
                ),
        ),
      ),
    );
  }

  Widget _buildControlBtn({required IconData icon, double size = 18, bool isActive = false, required VoidCallback onPressed}) {
    return IconButton(
      icon: Icon(icon, size: size, color: isActive ? Colors.white : Colors.white38),
      onPressed: onPressed,
      splashRadius: 20,
      padding: EdgeInsets.zero,
      constraints: const BoxConstraints(minWidth: 40, minHeight: 40),
    );
  }

  Widget _buildEmptyState(String tips) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.music_note_rounded, size: 48, color: Colors.white.withAlpha(8)),
          const SizedBox(height: 16),
          Text(
            tips,
            style: TextStyle(color: Colors.white.withAlpha(15), fontSize: 16, fontWeight: FontWeight.w700),
          ),
        ],
      ),
    );
  }
}