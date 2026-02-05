import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import '../../theme/app_theme.dart';
import '../../providers/audio_provider.dart';
import '../../providers/persistence_provider.dart';
import 'cover_image.dart';

class QueueDrawer extends StatelessWidget {
  const QueueDrawer({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final modernTheme = theme.extension<AppModernTheme>()!;

    return Container(
      width: 350,
      decoration: BoxDecoration(
        color: modernTheme.sidebarColor,
      ),
      child: Column(
        children: [
          // Header
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
            decoration: BoxDecoration(
              border: Border(
                bottom: BorderSide(
                  color: modernTheme.dividerColor!,
                  width: 0.8,
                ),
              ),
            ),
            child: Row(
              children: [
                Text(
                  '播放队列',
                  style: TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w700,
                    color: theme.colorScheme.onSurface,
                  ),
                ),
                const Spacer(),
                Consumer2<AudioProvider, PersistenceProvider>(
                  builder: (context, audio, persistence, child) {
                    final songCount = audio.playlist.length;
                    if (songCount == 0) return const SizedBox.shrink();
                    return Text(
                      '$songCount 首',
                      style: TextStyle(
                        fontSize: 12,
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
                    );
                  },
                ),
              ],
            ),
          ),

          // Queue List
          Expanded(
            child: Consumer<AudioProvider>(
              builder: (context, audioProvider, child) {
                final playlist = audioProvider.playlist;
                final currentIndex = audioProvider.currentIndex;

                if (playlist.isEmpty) {
                  return Center(
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Icon(
                          CupertinoIcons.music_note_list,
                          size: 48,
                          color: theme.colorScheme.onSurface.withAlpha(40),
                        ),
                        const SizedBox(height: 12),
                        Text(
                          '播放队列为空',
                          style: TextStyle(
                            fontSize: 14,
                            color: theme.colorScheme.onSurfaceVariant,
                          ),
                        ),
                      ],
                    ),
                  );
                }

                return ListView.builder(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  itemCount: playlist.length,
                  itemBuilder: (context, index) {
                    final song = playlist[index];
                    final isCurrent = index == currentIndex;

                    return Container(
                      margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 2),
                      decoration: BoxDecoration(
                        color: isCurrent
                            ? theme.colorScheme.primary.withAlpha(20)
                            : Colors.transparent,
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: ListTile(
                        contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
                        leading: CoverImage(
                          url: song.cover,
                          width: 40,
                          height: 40,
                          borderRadius: 6,
                          showShadow: false,
                          size: 80,
                        ),
                        title: Text(
                          song.name,
                          style: TextStyle(
                            fontSize: 13,
                            fontWeight: isCurrent ? FontWeight.w700 : FontWeight.w600,
                            color: isCurrent ? theme.colorScheme.primary : null,
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        subtitle: Text(
                          song.singerName,
                          style: TextStyle(
                            fontSize: 11,
                            color: theme.colorScheme.onSurfaceVariant,
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        trailing: isCurrent
                            ? Icon(
                                CupertinoIcons.play_fill,
                                size: 14,
                                color: theme.colorScheme.primary,
                              )
                            : Icon(
                                CupertinoIcons.play_circle,
                                size: 20,
                                color: theme.colorScheme.onSurface.withAlpha(80),
                              ),
                        onTap: () {
                          audioProvider.playSong(song, playlist: playlist);
                        },
                      ),
                    );
                  },
                );
              },
            ),
          ),

          // Footer actions
          Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              border: Border(
                top: BorderSide(
                  color: modernTheme.dividerColor!,
                  width: 0.8,
                ),
              ),
            ),
            child: Consumer<AudioProvider>(
              builder: (context, audioProvider, child) {
                final hasSongs = audioProvider.playlist.isNotEmpty;
                if (!hasSongs) return const SizedBox.shrink();

                return OutlinedButton.icon(
                  onPressed: () {
                    audioProvider.clearPlaylist();
                  },
                  icon: const Icon(CupertinoIcons.delete, size: 16),
                  label: const Text('清空列表', style: TextStyle(fontSize: 13)),
                  style: OutlinedButton.styleFrom(
                    foregroundColor: theme.colorScheme.onSurface,
                    side: BorderSide(
                      color: theme.colorScheme.outlineVariant,
                      width: 0.8,
                    ),
                    padding: const EdgeInsets.symmetric(vertical: 10),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(8),
                    ),
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}
