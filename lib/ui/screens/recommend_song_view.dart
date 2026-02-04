import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import '../../api/music_api.dart';
import '../../models/song.dart';
import '../widgets/song_card.dart';

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
    final isDark = Theme.of(context).brightness == Brightness.dark;

    return Scaffold(
      backgroundColor: Colors.transparent,
      appBar: CupertinoNavigationBar(
        backgroundColor: Colors.transparent,
        border: null,
        middle: Text(
          '每日推荐',
          style: TextStyle(color: isDark ? Colors.white : Colors.black),
        ),
      ),
      body: FutureBuilder<List<Song>>(
        future: _recommendSongsFuture,
        builder: (context, snapshot) {
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
            padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 20),
            itemCount: songs.length,
            itemBuilder: (context, index) {
              return SongCard(
                song: songs[index],
                playlist: songs,
                showMore: true,
              );
            },
          );
        },
      ),
    );
  }
}

