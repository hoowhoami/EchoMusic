import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import '../../api/music_api.dart';
import '../../models/song.dart';
import '../../providers/selection_provider.dart';
import '../widgets/song_card.dart';
import '../widgets/batch_action_bar.dart';

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
    final selectionProvider = context.watch<SelectionProvider>();

    return Scaffold(
      backgroundColor: Colors.transparent,
      appBar: CupertinoNavigationBar(
        backgroundColor: Colors.transparent,
        border: null,
        middle: Text(
          '每日推荐',
          style: TextStyle(color: isDark ? Colors.white : Colors.black),
        ),
        trailing: FutureBuilder<List<Song>>(
          future: _recommendSongsFuture,
          builder: (context, snapshot) {
            if (!snapshot.hasData || snapshot.data!.isEmpty) return const SizedBox.shrink();
            if (selectionProvider.isSelectionMode) return const SizedBox.shrink();

            return CupertinoButton(
              padding: EdgeInsets.zero,
              onPressed: () {
                selectionProvider.setSongList(snapshot.data!);
                selectionProvider.enterSelectionMode();
              },
              child: Icon(
                CupertinoIcons.checkmark_circle,
                size: 22,
                color: isDark ? Colors.white54 : Colors.black54,
              ),
            );
          },
        ),
      ),
      body: Column(
        children: [
          Expanded(
            child: FutureBuilder<List<Song>>(
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
          const BatchActionBar(),
        ],
      ),
    );
  }
}

