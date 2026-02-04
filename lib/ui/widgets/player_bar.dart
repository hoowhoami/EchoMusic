import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:audio_video_progress_bar/audio_video_progress_bar.dart';
import 'package:just_audio/just_audio.dart';
import 'dart:ui';
import '../../providers/audio_provider.dart';
import '../../providers/persistence_provider.dart';
import '../screens/lyric_page.dart';
import 'package:cached_network_image/cached_network_image.dart';

class PlayerBar extends StatelessWidget {
  const PlayerBar({super.key});

  @override
  Widget build(BuildContext context) {
    return Consumer2<AudioProvider, PersistenceProvider>(
      builder: (context, audioProvider, persistenceProvider, child) {
        final song = audioProvider.currentSong;
        if (song == null) return const SizedBox.shrink();

        return ClipRect(
          child: BackdropFilter(
            filter: ImageFilter.blur(sigmaX: 20, sigmaY: 20),
            child: Container(
              height: 110,
              padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 16),
              decoration: BoxDecoration(
                color: Colors.black.withOpacity(0.6),
                border: Border(
                  top: BorderSide(
                    color: Colors.white.withOpacity(0.1),
                  ),
                ),
              ),
              child: Row(
                children: [
                  // Song Info
                  InkWell(
                    onTap: () {
                      Navigator.push(
                        context,
                        MaterialPageRoute(builder: (_) => const LyricPage()),
                      );
                    },
                    borderRadius: BorderRadius.circular(12),
                    child: SizedBox(
                      width: 260,
                      child: Row(
                        children: [
                          Hero(
                            tag: 'player_cover',
                            child: ClipRRect(
                              borderRadius: BorderRadius.circular(12),
                              child: CachedNetworkImage(
                                imageUrl: song.cover,
                                width: 64,
                                height: 64,
                                fit: BoxFit.cover,
                              ),
                            ),
                          ),
                          const SizedBox(width: 16),
                          Expanded(
                            child: Column(
                              mainAxisAlignment: MainAxisAlignment.center,
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  song.name,
                                  style: const TextStyle(
                                    fontWeight: FontWeight.bold,
                                    fontSize: 16,
                                    color: Colors.white,
                                  ),
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                ),
                                const SizedBox(height: 4),
                                Text(
                                  song.singerName,
                                  style: TextStyle(
                                    color: Colors.white.withOpacity(0.6),
                                    fontSize: 14,
                                  ),
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                  
                  // Like Button
                  IconButton(
                    icon: Icon(
                      persistenceProvider.isFavorite(song) ? Icons.favorite : Icons.favorite_border,
                      color: persistenceProvider.isFavorite(song) ? Colors.redAccent : Colors.white60,
                    ),
                    onPressed: () => persistenceProvider.toggleFavorite(song),
                  ),
                  const SizedBox(width: 10),

                  // Controls & Progress
                  Expanded(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            IconButton(
                              icon: Icon(
                                audioProvider.isShuffle ? Icons.shuffle_rounded : Icons.trending_flat_rounded,
                                size: 20,
                              ),
                              color: audioProvider.isShuffle ? Colors.cyanAccent : Colors.white38,
                              onPressed: audioProvider.toggleShuffle,
                            ),
                            const SizedBox(width: 16),
                            IconButton(
                              icon: const Icon(Icons.skip_previous_rounded),
                              onPressed: audioProvider.previous,
                              color: Colors.white,
                            ),
                            const SizedBox(width: 16),
                            Container(
                              decoration: const BoxDecoration(
                                shape: BoxShape.circle,
                                color: Colors.white,
                              ),
                              child: IconButton(
                                iconSize: 32,
                                icon: Icon(
                                  audioProvider.isPlaying
                                      ? Icons.pause_rounded
                                      : Icons.play_arrow_rounded,
                                ),
                                color: Colors.black,
                                onPressed: audioProvider.togglePlay,
                              ),
                            ),
                            const SizedBox(width: 16),
                            IconButton(
                              icon: const Icon(Icons.skip_next_rounded),
                              onPressed: audioProvider.next,
                              color: Colors.white,
                            ),
                            const SizedBox(width: 16),
                            IconButton(
                              icon: Icon(
                                audioProvider.loopMode == LoopMode.one
                                    ? Icons.repeat_one_rounded
                                    : (audioProvider.loopMode == LoopMode.all
                                        ? Icons.repeat_rounded
                                        : Icons.arrow_forward_rounded),
                                size: 20,
                              ),
                              color: audioProvider.loopMode != LoopMode.off
                                  ? Colors.cyanAccent
                                  : Colors.white38,
                              onPressed: audioProvider.toggleLoopMode,
                            ),
                          ],
                        ),
                        const SizedBox(height: 8),
                        SizedBox(
                          width: 600,
                          child: StreamBuilder<Duration>(
                            stream: audioProvider.player.positionStream,
                            builder: (context, snapshot) {
                              final position = snapshot.data ?? Duration.zero;
                              final total = audioProvider.player.duration ?? Duration.zero;
                              return ProgressBar(
                                progress: position,
                                total: total,
                                barHeight: 4,
                                baseBarColor: Colors.white.withOpacity(0.1),
                                progressBarColor: Colors.cyanAccent,
                                thumbColor: Colors.cyanAccent,
                                thumbRadius: 6,
                                timeLabelTextStyle: TextStyle(
                                  color: Colors.white.withOpacity(0.5),
                                  fontSize: 12,
                                ),
                                onSeek: (duration) {
                                  audioProvider.player.seek(duration);
                                },
                              );
                            },
                          ),
                        ),
                      ],
                    ),
                  ),

                  // Volume & Others
                  SizedBox(
                    width: 300,
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.end,
                      children: [
                        const Icon(Icons.volume_up_rounded, size: 20, color: Colors.white60),
                        SizedBox(
                          width: 120,
                          child: StreamBuilder<double>(
                            stream: audioProvider.player.volumeStream,
                            builder: (context, snapshot) {
                              return SliderTheme(
                                data: SliderTheme.of(context).copyWith(
                                  trackHeight: 3,
                                  thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 6),
                                  overlayShape: const RoundSliderOverlayShape(overlayRadius: 14),
                                ),
                                child: Slider(
                                  value: snapshot.data ?? 1.0,
                                  activeColor: Colors.cyanAccent,
                                  inactiveColor: Colors.white.withOpacity(0.1),
                                  onChanged: (value) {
                                    audioProvider.player.setVolume(value);
                                  },
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
            ),
          ),
        );
      },
    );
  }
}