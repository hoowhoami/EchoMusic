import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'dart:ui';
import '../../providers/audio_provider.dart';
import '../../providers/lyric_provider.dart';
import 'package:cached_network_image/cached_network_image.dart';

class LyricPage extends StatefulWidget {
  const LyricPage({super.key});

  @override
  State<LyricPage> createState() => _LyricPageState();
}

class _LyricPageState extends State<LyricPage> {
  final ScrollController _scrollController = ScrollController();

  @override
  Widget build(BuildContext context) {
    final audioProvider = context.watch<AudioProvider>();
    final lyricProvider = context.watch<LyricProvider>();
    final song = audioProvider.currentSong;

    if (song == null) return const Scaffold();

    // Auto-scroll logic
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollController.hasClients && lyricProvider.currentLineIndex >= 0) {
        _scrollController.animateTo(
          lyricProvider.currentLineIndex * 60.0,
          duration: const Duration(milliseconds: 300),
          curve: Curves.easeInOut,
        );
      }
    });

    return Scaffold(
      extendBodyBehindAppBar: true,
      appBar: AppBar(
        backgroundColor: Colors.transparent,
        elevation: 0,
        leading: IconButton(
          icon: const Icon(Icons.keyboard_arrow_down_rounded, size: 32),
          onPressed: () => Navigator.pop(context),
        ),
      ),
      body: Stack(
        children: [
          // Background Cover Blur
          Positioned.fill(
            child: CachedNetworkImage(
              imageUrl: song.cover,
              fit: BoxFit.cover,
            ),
          ),
          Positioned.fill(
            child: BackdropFilter(
              filter: ImageFilter.blur(sigmaX: 100, sigmaY: 100),
              child: Container(
                color: Colors.black.withOpacity(0.7),
              ),
            ),
          ),

          // Content
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 50, vertical: 80),
            child: Row(
              children: [
                // Left side: Cover Art
                Expanded(
                  child: Center(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Hero(
                          tag: 'player_cover',
                          child: Container(
                            width: 400,
                            height: 400,
                            decoration: BoxDecoration(
                              borderRadius: BorderRadius.circular(24),
                              boxShadow: [
                                BoxShadow(
                                  color: Colors.black.withOpacity(0.5),
                                  blurRadius: 40,
                                  spreadRadius: 10,
                                ),
                              ],
                            ),
                            child: ClipRRect(
                              borderRadius: BorderRadius.circular(24),
                              child: CachedNetworkImage(
                                imageUrl: song.cover,
                                fit: BoxFit.cover,
                              ),
                            ),
                          ),
                        ),
                        const SizedBox(height: 40),
                        Text(
                          song.name,
                          style: const TextStyle(
                            fontSize: 32,
                            fontWeight: FontWeight.bold,
                            color: Colors.white,
                          ),
                          textAlign: TextAlign.center,
                        ),
                        const SizedBox(height: 8),
                        Text(
                          song.singerName,
                          style: TextStyle(
                            fontSize: 20,
                            color: Colors.white.withOpacity(0.6),
                          ),
                          textAlign: TextAlign.center,
                        ),
                      ],
                    ),
                  ),
                ),

                // Right side: Lyrics
                Expanded(
                  child: lyricProvider.lyrics.isEmpty
                      ? const Center(
                          child: Text(
                            '暂无歌词',
                            style: TextStyle(color: Colors.white54, fontSize: 20),
                          ),
                        )
                      : ListView.builder(
                          controller: _scrollController,
                          itemCount: lyricProvider.lyrics.length,
                          padding: const EdgeInsets.symmetric(vertical: 200),
                          itemBuilder: (context, index) {
                            final isCurrentLine =
                                lyricProvider.currentLineIndex == index;
                            return AnimatedContainer(
                              duration: const Duration(milliseconds: 300),
                              padding: const EdgeInsets.symmetric(vertical: 20),
                              child: Text(
                                lyricProvider.lyrics[index].text,
                                style: TextStyle(
                                  fontSize: isCurrentLine ? 28 : 22,
                                  fontWeight: isCurrentLine
                                      ? FontWeight.bold
                                      : FontWeight.normal,
                                  color: isCurrentLine
                                      ? Colors.cyanAccent
                                      : Colors.white.withOpacity(0.3),
                                ),
                                textAlign: TextAlign.left,
                              ),
                            );
                          },
                        ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
