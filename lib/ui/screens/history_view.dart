import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../providers/persistence_provider.dart';
import '../../providers/user_provider.dart';
import '../../providers/selection_provider.dart';
import '../widgets/song_card.dart';
import '../widgets/batch_selection_scaffold.dart';

class HistoryView extends StatelessWidget {
  const HistoryView({super.key});

  @override
  Widget build(BuildContext context) {
    final selectionProvider = context.watch<SelectionProvider>();
    final userProvider = context.watch<UserProvider>();
    final persistenceProvider = context.watch<PersistenceProvider>();
    final songs = userProvider.isAuthenticated ? userProvider.userHistory : persistenceProvider.history;

    return BatchSelectionScaffold(
      title: '最近播放',
      songs: songs,
      body: Consumer2<PersistenceProvider, UserProvider>(
        builder: (context, persistence, user, _) {
          final displaySongs = user.isAuthenticated ? user.userHistory : persistence.history;
          if (displaySongs.isEmpty) {
            final theme = Theme.of(context);
            return Center(
              child: Text(
                '暂无历史', 
                style: TextStyle(
                  fontWeight: FontWeight.w600, 
                  color: theme.colorScheme.onSurface.withAlpha(128),
                ),
              ),
            );
          }
          return ListView.builder(
            padding: const EdgeInsets.symmetric(horizontal: 28),
            itemCount: displaySongs.length,
            itemBuilder: (context, index) {
              final song = displaySongs[index];
              return SongCard(
                song: song,
                playlist: displaySongs,
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
    );
  }
}
