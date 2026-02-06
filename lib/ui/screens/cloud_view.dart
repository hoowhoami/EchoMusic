import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import '../../api/music_api.dart';
import '../../models/song.dart';
import '../../providers/user_provider.dart';
import '../../providers/selection_provider.dart';
import '../widgets/song_card.dart';
import '../widgets/batch_selection_scaffold.dart';

class CloudView extends StatefulWidget {
  const CloudView({super.key});

  @override
  State<CloudView> createState() => _CloudViewState();
}

class _CloudViewState extends State<CloudView> {
  late Future<List<Song>> _cloudSongsFuture;

  @override
  void initState() {
    super.initState();
    _cloudSongsFuture = MusicApi.getUserCloud();
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

    return FutureBuilder<List<Song>>(
      future: _cloudSongsFuture,
      builder: (context, snapshot) {
        final songs = snapshot.data ?? [];
        return BatchSelectionScaffold(
          title: '音乐云盘',
          songs: songs,
          body: _buildBody(snapshot, selectionProvider),
        );
      },
    );
  }

  Widget _buildBody(AsyncSnapshot<List<Song>> snapshot, SelectionProvider selectionProvider) {
    if (snapshot.connectionState == ConnectionState.waiting) {
      return const Center(child: CupertinoActivityIndicator());
    }
    final songs = snapshot.data ?? [];
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
          isSelectionMode: selectionProvider.isSelectionMode,
          isSelected: selectionProvider.isSelected(song.hash),
          onSelectionChanged: (selected) {
            selectionProvider.toggleSelection(song.hash);
          },
        );
      },
    );
  }
}
