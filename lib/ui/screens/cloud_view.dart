import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import '../../api/music_api.dart';
import '../../models/song.dart';
import '../../providers/user_provider.dart';
import '../../providers/selection_provider.dart';
import '../widgets/song_card.dart';
import '../widgets/batch_action_bar.dart';

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
    final isDark = Theme.of(context).brightness == Brightness.dark;

    if (!userProvider.isAuthenticated) {
      return const Center(child: Text('登录后查看云盘', style: TextStyle(color: Colors.white30)));
    }

    return Scaffold(
      backgroundColor: Colors.transparent,
      body: Column(
        children: [
          Expanded(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 40, vertical: 30),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Text(
                        '音乐云盘',
                        style: TextStyle(
                          fontSize: 28,
                          fontWeight: FontWeight.w700,
                          color: isDark ? Colors.white : Colors.black,
                          letterSpacing: -0.5,
                        ),
                      ),
                      const Spacer(),
                      FutureBuilder<List<Song>>(
                        future: _cloudSongsFuture,
                        builder: (context, snapshot) {
                          final songs = snapshot.data ?? [];
                          if (songs.isEmpty || selectionProvider.isSelectionMode) {
                            return const SizedBox.shrink();
                          }
                          return IconButton(
                            icon: const Icon(CupertinoIcons.checkmark_circle, size: 22),
                            onPressed: () {
                              selectionProvider.setSongList(songs);
                              selectionProvider.enterSelectionMode();
                            },
                            color: isDark ? Colors.white54 : Colors.black54,
                            tooltip: '批量选择',
                          );
                        },
                      ),
                    ],
                  ),
                  const SizedBox(height: 24),
                  Expanded(
                    child: FutureBuilder<List<Song>>(
                      future: _cloudSongsFuture,
                      builder: (context, snapshot) {
                        if (snapshot.connectionState == ConnectionState.waiting) {
                          return const Center(child: CupertinoActivityIndicator());
                        }
                        final songs = snapshot.data ?? [];
                        if (songs.isEmpty) {
                          return const Center(
                            child: Text('云盘暂无歌曲', style: TextStyle(color: Colors.white30)),
                          );
                        }

                        return ListView.builder(
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
                ],
              ),
            ),
          ),
          const BatchActionBar(),
        ],
      ),
    );
  }
}
