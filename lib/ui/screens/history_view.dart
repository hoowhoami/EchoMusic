import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import '../../providers/persistence_provider.dart';
import '../../providers/selection_provider.dart';
import '../widgets/song_card.dart';
import '../widgets/batch_action_bar.dart';

class HistoryView extends StatelessWidget {
  const HistoryView({super.key});

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final selectionProvider = context.watch<SelectionProvider>();

    return Scaffold(
      backgroundColor: Colors.transparent,
      body: Column(
        children: [
          Expanded(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 40, vertical: 30),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Text(
                        '最近播放',
                        style: TextStyle(
                          fontSize: 28,
                          fontWeight: FontWeight.w700,
                          color: isDark ? Colors.white : Colors.black,
                          letterSpacing: -0.5,
                        ),
                      ),
                      const Spacer(),
                      Consumer<PersistenceProvider>(
                        builder: (context, persistence, _) {
                          final songs = persistence.history;
                          if (songs.isEmpty || selectionProvider.isSelectionMode) {
                            return const SizedBox.shrink();
                          }
                          return IconButton(
                            icon: const Icon(CupertinoIcons.checkmark_circle, size: 22),
                            onPressed: () {
                              selectionProvider.setSongList(songs);
                              selectionProvider.enterSelectionMode();
                            },
                            color: isDark ? Colors.white54 : Colors.black54,
                            tooltip: '批量选择',
                          );
                        },
                      ),
                    ],
                  ),
                  const SizedBox(height: 24),
                  Expanded(
                    child: Consumer<PersistenceProvider>(
                      builder: (context, persistence, _) {
                        final songs = persistence.history;
                        if (songs.isEmpty) {
                          return const Center(
                            child: Text('暂无历史', style: TextStyle(color: Colors.white30)),
                          );
                        }
                        return ListView.builder(
                          itemCount: songs.length,
                          itemBuilder: (context, index) {
                            final song = songs[index];
                            return SongCard(
                              song: song,
                              playlist: songs,
                              showMore: true,
                              isSelectionMode: selectionProvider.isSelectionMode,
                              isSelected: selectionProvider.isSelected(song.hash),
                              onSelectionChanged: (selected) {
                                selectionProvider.toggleSelection(song.hash);
                              },
                            );
                          },
                        );
                      },
                    ),
                  ),
                ],
              ),
            ),
          ),
          const BatchActionBar(),
        ],
      ),
    );
  }
}
