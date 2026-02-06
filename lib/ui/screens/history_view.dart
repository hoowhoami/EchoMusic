import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../providers/persistence_provider.dart';
import '../../providers/user_provider.dart';
import '../widgets/song_list_scaffold.dart';

class HistoryView extends StatelessWidget {
  const HistoryView({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final userProvider = context.watch<UserProvider>();
    final persistenceProvider = context.watch<PersistenceProvider>();
    final songs = userProvider.isAuthenticated ? userProvider.userHistory : persistenceProvider.history;

    return SongListScaffold(
      songs: songs,
      headers: [
        SliverToBoxAdapter(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(40, 20, 40, 10),
            child: Text(
              '最近播放',
              style: TextStyle(
                fontSize: 28,
                fontWeight: FontWeight.w800,
                color: theme.colorScheme.onSurface,
                letterSpacing: -0.6,
              ),
            ),
          ),
        ),
      ],
    );
  }
}
