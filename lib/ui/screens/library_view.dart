import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../providers/persistence_provider.dart';
import '../../providers/audio_provider.dart';
import '../../providers/user_provider.dart';
import '../../models/song.dart';
import 'package:cached_network_image/cached_network_image.dart';
import 'artist_detail_view.dart';
import 'login_screen.dart';

class LibraryView extends StatelessWidget {
  const LibraryView({super.key});

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 4,
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
                Tab(text: '我的关注'),
                Tab(text: '音乐云盘'),
              ],
            ),
            const SizedBox(height: 20),
            Expanded(
              child: TabBarView(
                children: [
                  _SongList(type: 'favorites'),
                  _SongList(type: 'history'),
                  const _FollowList(),
                  const _CloudList(),
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

class _FollowList extends StatelessWidget {
  const _FollowList();

  @override
  Widget build(BuildContext context) {
    final userProvider = context.watch<UserProvider>();
    if (!userProvider.isAuthenticated) {
      return _buildLoginPrompt(context);
    }

    final follows = userProvider.userFollows;
    if (follows.isEmpty) {
      return const Center(child: Text('暂无关注', style: TextStyle(color: Colors.white30)));
    }

    return ListView.builder(
      itemCount: follows.length,
      itemBuilder: (context, index) {
        final follow = follows[index];
        final String? avatar = follow['imgurl']?.replaceAll('{size}', '200');
        
        return ListTile(
          leading: CircleAvatar(
            backgroundImage: avatar != null ? CachedNetworkImageProvider(avatar) : null,
            child: avatar == null ? const Icon(Icons.person) : null,
          ),
          title: Text(follow['singername'] ?? '', style: const TextStyle(color: Colors.white)),
          onTap: () {
            Navigator.push(
              context,
              MaterialPageRoute(
                builder: (_) => ArtistDetailView(
                  artistId: follow['singerid'],
                  artistName: follow['singername'],
                ),
              ),
            );
          },
        );
      },
    );
  }

  Widget _buildLoginPrompt(BuildContext context) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const Text('登录后查看关注', style: TextStyle(color: Colors.white54)),
          const SizedBox(height: 16),
          ElevatedButton(
            onPressed: () {
              Navigator.push(context, MaterialPageRoute(builder: (_) => const LoginScreen()));
            },
            child: const Text('去登录'),
          ),
        ],
      ),
    );
  }
}

class _CloudList extends StatelessWidget {
  const _CloudList();

  @override
  Widget build(BuildContext context) {
    final userProvider = context.watch<UserProvider>();
    if (!userProvider.isAuthenticated) {
      return _buildLoginPrompt(context);
    }

    final songs = userProvider.userCloud;
    if (songs.isEmpty) {
      return const Center(child: Text('云盘暂无歌曲', style: TextStyle(color: Colors.white30)));
    }

    return ListView.builder(
      itemCount: songs.length,
      itemBuilder: (context, index) {
        final song = songs[index];
        return ListTile(
          leading: const Icon(Icons.cloud_queue, color: Colors.cyanAccent),
          title: Text(song.name, style: const TextStyle(color: Colors.white)),
          subtitle: Text(song.singerName, style: const TextStyle(color: Colors.white54)),
          onTap: () {
            context.read<AudioProvider>().playSong(song, playlist: songs);
          },
        );
      },
    );
  }

  Widget _buildLoginPrompt(BuildContext context) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const Text('登录后查看云盘', style: TextStyle(color: Colors.white54)),
          const SizedBox(height: 16),
          ElevatedButton(
            onPressed: () {
              Navigator.push(context, MaterialPageRoute(builder: (_) => const LoginScreen()));
            },
            child: const Text('去登录'),
          ),
        ],
      ),
    );
  }
}


