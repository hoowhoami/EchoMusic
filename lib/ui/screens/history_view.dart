import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import '../../providers/persistence_provider.dart';
import '../../providers/user_provider.dart';
import '../../providers/selection_provider.dart';
import '../widgets/song_card.dart';
import '../widgets/batch_action_bar.dart';

class HistoryView extends StatelessWidget {
  const HistoryView({super.key});

  @override
  Widget build(BuildContext context) {
    final selectionProvider = context.watch<SelectionProvider>();
    final userProvider = context.watch<UserProvider>();

    final theme = Theme.of(context);

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
                          fontWeight: FontWeight.w800,
                          color: theme.colorScheme.onSurface,
                          letterSpacing: -0.6,
                        ),
                      ),
                      const Spacer(),
                      if (!selectionProvider.isSelectionMode)
                        IconButton(
                          icon: const Icon(CupertinoIcons.checkmark_circle, size: 22),
                          onPressed: () {
                            final songs = userProvider.isAuthenticated 
                                ? userProvider.userHistory 
                                : context.read<PersistenceProvider>().history;
                            if (songs.isNotEmpty) {
                              selectionProvider.setSongList(songs);
                              selectionProvider.enterSelectionMode();
                            }
                          },
                          color: theme.colorScheme.onSurfaceVariant,
                          tooltip: '批量选择',
                        ),
                    ],
                  ),
                  const SizedBox(height: 24),
                  Expanded(
                    child: Consumer2<PersistenceProvider, UserProvider>(
                      builder: (context, persistence, user, _) {
                        final songs = user.isAuthenticated ? user.userHistory : persistence.history;
                        if (songs.isEmpty) {
                          return Center(
                            child: Text(
                              '暂无历史', 
                              style: TextStyle(color: theme.colorScheme.onSurface.withAlpha(80), fontWeight: FontWeight.w600),
                            ),
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
