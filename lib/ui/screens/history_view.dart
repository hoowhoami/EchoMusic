import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../providers/persistence_provider.dart';
import '../../providers/user_provider.dart';
import '../../providers/refresh_provider.dart';
import '../widgets/song_list_scaffold.dart';

class HistoryView extends StatefulWidget {
  const HistoryView({super.key});

  @override
  State<HistoryView> createState() => _HistoryViewState();
}

class _HistoryViewState extends State<HistoryView> with RefreshableState<HistoryView> {
  bool _loaded = false;
  bool _wasAuthenticated = false;

  @override
  void onRefresh() {
    final userProvider = context.read<UserProvider>();
    if (userProvider.isAuthenticated) {
      userProvider.fetchUserHistory();
    }
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final userProvider = context.read<UserProvider>();
    final isAuthenticated = userProvider.isAuthenticated;
    if (isAuthenticated && (!_loaded || !_wasAuthenticated)) {
      _loaded = true;
      _wasAuthenticated = true;
      userProvider.fetchUserHistory();
    } else if (!isAuthenticated) {
      _wasAuthenticated = false;
      _loaded = false;
    }
  }

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
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.end,
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
                    const SizedBox(width: 12),
                    Padding(
                      padding: const EdgeInsets.only(bottom: 6),
                      child: Text(
                        '共 ${songs.length} 首',
                        style: TextStyle(
                          fontSize: 14,
                          fontWeight: FontWeight.w600,
                          color: theme.colorScheme.onSurface.withAlpha(128),
                        ),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}
