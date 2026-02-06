import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import '../../api/music_api.dart';
import '../../models/song.dart';
import '../../providers/selection_provider.dart';
import '../widgets/song_card.dart';
import '../widgets/batch_selection_scaffold.dart';

class RecommendSongView extends StatefulWidget {
  const RecommendSongView({super.key});

  @override
  State<RecommendSongView> createState() => _RecommendSongViewState();
}

class _RecommendSongViewState extends State<RecommendSongView> {
  late Future<List<Song>> _recommendSongsFuture;

  @override
  void initState() {
    super.initState();
    _recommendSongsFuture = MusicApi.getEverydayRecommend();
  }

  @override
  Widget build(BuildContext context) {
    final selectionProvider = context.watch<SelectionProvider>();

    return FutureBuilder<List<Song>>(
      future: _recommendSongsFuture,
      builder: (context, snapshot) {
        final songs = snapshot.data ?? [];
        return BatchSelectionScaffold(
          title: '每日推荐',
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
    if (snapshot.hasError || !snapshot.hasData) {
      return const Center(child: Text('加载失败'));
    }
    final songs = snapshot.data!;
    if (songs.isEmpty) {
      return const Center(child: Text('暂无推荐歌曲'));
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

