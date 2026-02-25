import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../models/song.dart';
import '../../providers/user_provider.dart';
import '../../providers/selection_provider.dart';
import '../../providers/refresh_provider.dart';
import '../widgets/song_card.dart';
import '../widgets/batch_selection_scaffold.dart';
import '../../utils/format_utils.dart';

class CloudView extends StatefulWidget {
  const CloudView({super.key});

  @override
  State<CloudView> createState() => _CloudViewState();
}

class _CloudViewState extends State<CloudView> {
  late RefreshProvider _refreshProvider;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _refreshProvider = context.watch<RefreshProvider>();
    _refreshProvider.addListener(_onRefresh);
  }

  @override
  void dispose() {
    _refreshProvider.removeListener(_onRefresh);
    super.dispose();
  }

  void _onRefresh() {
    if (mounted) {
      // UserProvider.fetchAllUserData() is already called by the title bar refresh button,
      // which will update userProvider.userCloud and trigger a rebuild here.
      setState(() {});
    }
  }

  @override
  Widget build(BuildContext context) {
    final userProvider = context.watch<UserProvider>();
    final selectionProvider = context.watch<SelectionProvider>();

    if (!userProvider.isAuthenticated) {
      final theme = Theme.of(context);
      return Center(
        child: Text(
          '登录后查看云盘', 
          style: TextStyle(
            fontWeight: FontWeight.w600, 
            color: theme.colorScheme.onSurface.withAlpha(128),
          ),
        ),
      );
    }

    final songs = userProvider.userCloud;
    return BatchSelectionScaffold(
      title: '音乐云盘',
      songs: songs,
      body: _buildBody(songs, selectionProvider, userProvider),
    );
  }

  Widget _buildCloudInfo(UserProvider userProvider) {
    final theme = Theme.of(context);
    final used = userProvider.cloudCapacity - userProvider.cloudAvailable;
    final total = userProvider.cloudCapacity;
    final percentage = total > 0 ? (used / total) : 0.0;

    return Container(
      margin: const EdgeInsets.only(bottom: 20),
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHighest.withAlpha(100),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(
          color: theme.colorScheme.outlineVariant.withAlpha(80),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                '云盘容量',
                style: TextStyle(
                  fontSize: 14,
                  fontWeight: FontWeight.w700,
                  color: theme.colorScheme.onSurface,
                ),
              ),
              Text(
                '${(percentage * 100).toStringAsFixed(1)}%',
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  color: theme.colorScheme.primary,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          ClipRRect(
            borderRadius: BorderRadius.circular(4),
            child: LinearProgressIndicator(
              value: percentage,
              minHeight: 8,
              backgroundColor: theme.colorScheme.surfaceContainerHighest,
              valueColor: AlwaysStoppedAnimation<Color>(
                percentage > 0.9 ? theme.colorScheme.error : theme.colorScheme.primary,
              ),
            ),
          ),
          const SizedBox(height: 12),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                '${formatBytes(used)} / ${formatBytes(total)}',
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w500,
                  color: theme.colorScheme.onSurface.withAlpha(160),
                ),
              ),
              Text(
                '可用 ${formatBytes(userProvider.cloudAvailable)}',
                style: TextStyle(
                  fontSize: 12,
                  fontWeight: FontWeight.w500,
                  color: theme.colorScheme.onSurface.withAlpha(128),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildBody(List<Song> songs, SelectionProvider selectionProvider, UserProvider userProvider) {
    if (songs.isEmpty && userProvider.cloudCapacity == 0) {
      final theme = Theme.of(context);
      return Center(
        child: Text(
          '云盘暂无歌曲', 
          style: TextStyle(
            fontWeight: FontWeight.w600, 
            color: theme.colorScheme.onSurface.withAlpha(128),
          ),
        ),
      );
    }

    return ListView.builder(
      padding: EdgeInsets.fromLTRB(28, 0, 28, selectionProvider.isSelectionMode ? 100 : 20),
      itemCount: songs.length + 1,
      itemBuilder: (context, index) {
        if (index == 0) {
          return _buildCloudInfo(userProvider);
        }
        final song = songs[index - 1];
        return SongCard(
          song: song,
          playlist: songs,
          showMore: true,
        );
      },
    );
  }
}
