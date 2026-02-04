import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'dart:ui';
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

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final audioProvider = context.watch<AudioProvider>();
    final lyricProvider = context.watch<LyricProvider>();
    final song = audioProvider.currentSong;

    if (song == null) return const Scaffold();

    // Auto-scroll logic
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollController.hasClients && lyricProvider.currentLineIndex >= 0) {
        _scrollController.animateTo(
          lyricProvider.currentLineIndex * 70.0,
          duration: const Duration(milliseconds: 500),
          curve: Curves.easeOutCubic,
        );
      }
    });

    return Scaffold(
      extendBodyBehindAppBar: true,
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        elevation: 0,
        leading: IconButton(
          icon: const Icon(Icons.keyboard_arrow_down_rounded, size: 36, color: Colors.white),
          onPressed: () => Navigator.pop(context),
        ),
      ),
      body: Stack(
        children: [
          // Background Cover Blur
          Positioned.fill(
            child: CoverImage(
              url: song.cover,
              borderRadius: 0,
              showShadow: false,
              fit: BoxFit.cover,
              size: 800,
            ),
          ),
          Positioned.fill(
            child: BackdropFilter(
              filter: ImageFilter.blur(sigmaX: 100, sigmaY: 100),
              child: Container(
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    begin: Alignment.topCenter,
                    end: Alignment.bottomCenter,
                    colors: [
                      Colors.black.withAlpha(180),
                      Colors.black.withAlpha(120),
                      Colors.black.withAlpha(220),
                    ],
                  ),
                ),
              ),
            ),
          ),

          // Content
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 80, vertical: 40),
            child: Row(
              children: [
                // Left side: Cover Art
                Expanded(
                  flex: 5,
                  child: Center(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Hero(
                          tag: 'player_cover',
                          child: CoverImage(
                            url: song.cover,
                            width: 460,
                            height: 460,
                            borderRadius: 32,
                            size: 1000,
                          ),
                        ),
                        const SizedBox(height: 48),
                        Text(
                          song.name,
                          style: const TextStyle(
                            fontSize: 36,
                            fontWeight: FontWeight.w900,
                            color: Colors.white,
                            letterSpacing: -1,
                          ),
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                        ),
                        const SizedBox(height: 12),
                        Text(
                          song.singerName,
                          style: TextStyle(
                            fontSize: 22,
                            fontWeight: FontWeight.w600,
                            color: Colors.white.withAlpha(150),
                            letterSpacing: -0.5,
                          ),
                        ),
                        const SizedBox(height: 40),
                        _buildSongInfo(context, song),
                      ],
                    ),
                  ),
                ),

                const SizedBox(width: 60),

                // Right side: Lyrics
                Expanded(
                  flex: 6,
                  child: lyricProvider.lyrics.isEmpty
                      ? Center(
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Icon(Icons.music_note_rounded, size: 64, color: Colors.white.withAlpha(30)),
                              const SizedBox(height: 16),
                              Text(
                                '暂无歌词',
                                style: TextStyle(
                                  color: Colors.white.withAlpha(100), 
                                  fontSize: 20,
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                            ],
                          ),
                        )
                      : ShaderMask(
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
                            padding: const EdgeInsets.symmetric(vertical: 300),
                            itemBuilder: (context, index) {
                              final isCurrentLine = lyricProvider.currentLineIndex == index;
                              return AnimatedOpacity(
                                duration: const Duration(milliseconds: 300),
                                opacity: isCurrentLine ? 1.0 : 0.3,
                                child: InkWell(
                                  onTap: () {
                                    // Optional: Seek to lyric time
                                  },
                                  child: Container(
                                    padding: const EdgeInsets.symmetric(vertical: 18),
                                    child: Text(
                                      lyricProvider.lyrics[index].text,
                                      style: TextStyle(
                                        fontSize: isCurrentLine ? 32 : 24,
                                        fontWeight: isCurrentLine ? FontWeight.w900 : FontWeight.w700,
                                        color: isCurrentLine ? theme.colorScheme.primary : Colors.white,
                                        letterSpacing: -0.5,
                                        height: 1.4,
                                      ),
                                      textAlign: TextAlign.left,
                                    ),
                                  ),
                                ),
                              );
                            },
                          ),
                        ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildSongInfo(BuildContext context, dynamic song) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
      decoration: BoxDecoration(
        color: Colors.white.withAlpha(20),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: Colors.white10),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.album_rounded, size: 16, color: Colors.white.withAlpha(150)),
          const SizedBox(width: 8),
          Text(
            song.albumName,
            style: TextStyle(
              color: Colors.white.withAlpha(150),
              fontSize: 14,
              fontWeight: FontWeight.w600,
            ),
          ),
        ],
      ),
    );
  }
}
