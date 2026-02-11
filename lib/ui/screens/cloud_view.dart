import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../models/song.dart';
import '../../providers/user_provider.dart';
import '../../providers/selection_provider.dart';
import '../../providers/refresh_provider.dart';
import '../widgets/song_card.dart';
import '../widgets/batch_selection_scaffold.dart';

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
      body: _buildBody(songs, selectionProvider),
    );
  }

  Widget _buildBody(List<Song> songs, SelectionProvider selectionProvider) {
    if (songs.isEmpty) {
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
      padding: const EdgeInsets.symmetric(horizontal: 28),
      itemCount: songs.length,
      itemBuilder: (context, index) {
        final song = songs[index];
        return SongCard(
          song: song,
          playlist: songs,
          showMore: true,
        );
      },
    );
  }
}
