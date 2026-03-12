import 'package:flutter/cupertino.dart';
import '../../api/music_api.dart';
import '../../models/song.dart';
import '../widgets/song_card.dart';
import '../widgets/batch_selection_scaffold.dart';
import '../widgets/back_to_top.dart';

class RecommendSongView extends StatefulWidget {
  const RecommendSongView({super.key});

  @override
  State<RecommendSongView> createState() => _RecommendSongViewState();
}

class _RecommendSongViewState extends State<RecommendSongView> {
  final ScrollController _scrollController = ScrollController();
  late Future<List<Song>> _recommendSongsFuture;

  @override
  void initState() {
    super.initState();
    _recommendSongsFuture = MusicApi.getEverydayRecommend();
  }

  @override
  void dispose() {
    _scrollController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<List<Song>>(
      future: _recommendSongsFuture,
      builder: (context, snapshot) {
        final songs = snapshot.data ?? [];
        return BatchSelectionScaffold(
          title: '每日推荐',
          songs: songs,
          body: _buildBody(snapshot),
        );
      },
    );
  }

  Widget _buildBody(AsyncSnapshot<List<Song>> snapshot) {
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

    return Stack(
      children: [
        ListView.builder(
          controller: _scrollController,
          padding: const EdgeInsets.fromLTRB(28, 0, 28, 20),
          itemCount: songs.length,
          itemBuilder: (context, index) {
            final song = songs[index];
            return SongCard(
              song: song,
              playlist: songs,
              showMore: true,
              enableDefaultDoubleTapPlay: true,
            );
          },
        ),
        BackToTop(controller: _scrollController),
      ],
    );
  }
}

