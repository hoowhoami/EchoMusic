import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../providers/persistence_provider.dart';
import '../../providers/audio_provider.dart';
import '../../models/song.dart';
import 'package:cached_network_image/cached_network_image.dart';

class LibraryView extends StatelessWidget {
  const LibraryView({super.key});

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 2,
      child: Padding(
        padding: const EdgeInsets.all(30.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const TabBar(
              isScrollable: true,
              indicatorColor: Colors.cyanAccent,
              labelColor: Colors.cyanAccent,
              unselectedLabelColor: Colors.white54,
              tabs: [
                Tab(text: '我的收藏'),
                Tab(text: '最近播放'),
              ],
            ),
            const SizedBox(height: 20),
            Expanded(
              child: TabBarView(
                children: [
                  _SongList(type: 'favorites'),
                  _SongList(type: 'history'),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SongList extends StatelessWidget {
  final String type;
  const _SongList({required this.type});

  @override
  Widget build(BuildContext context) {
    return Consumer<PersistenceProvider>(
      builder: (context, persistence, child) {
        final songs = type == 'favorites' ? persistence.favorites : persistence.history;
        
        if (songs.isEmpty) {
          return Center(
            child: Text(
              type == 'favorites' ? '暂无收藏歌曲' : '暂无播放历史',
              style: const TextStyle(color: Colors.white30),
            ),
          );
        }

        return ListView.builder(
          itemCount: songs.length,
          itemBuilder: (context, index) {
            final song = songs[index];
            return ListTile(
              leading: ClipRRect(
                borderRadius: BorderRadius.circular(4),
                child: CachedNetworkImage(
                  imageUrl: song.cover,
                  width: 50,
                  height: 50,
                  fit: BoxFit.cover,
                ),
              ),
              title: Text(song.name, style: const TextStyle(color: Colors.white)),
              subtitle: Text(song.singerName, style: const TextStyle(color: Colors.white54)),
              trailing: IconButton(
                icon: Icon(
                  persistence.isFavorite(song) ? Icons.favorite : Icons.favorite_border,
                  color: persistence.isFavorite(song) ? Colors.redAccent : Colors.white30,
                ),
                onPressed: () => persistence.toggleFavorite(song),
              ),
              onTap: () {
                context.read<AudioProvider>().playSong(song, playlist: songs);
              },
            );
          },
        );
      },
    );
  }
}
