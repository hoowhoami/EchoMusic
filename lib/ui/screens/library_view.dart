import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../providers/persistence_provider.dart';
import '../../providers/audio_provider.dart';
import '../../providers/user_provider.dart';
import 'package:cached_network_image/cached_network_image.dart';
import '../widgets/song_card.dart';
import 'artist_detail_view.dart';
import 'login_screen.dart';

class LibraryView extends StatelessWidget {
  const LibraryView({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return DefaultTabController(
      length: 4,
      child: Padding(
        padding: const EdgeInsets.all(30.0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            TabBar(
              isScrollable: true,
              indicatorColor: theme.colorScheme.primary,
              labelColor: theme.colorScheme.primary,
              unselectedLabelColor: theme.colorScheme.onSurfaceVariant,
              tabs: const [
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
    final theme = Theme.of(context);
    return Consumer<PersistenceProvider>(
      builder: (context, persistence, child) {
        final songs = type == 'favorites' ? persistence.favorites : persistence.history;
        
        if (songs.isEmpty) {
          return Center(
            child: Text(
              type == 'favorites' ? '暂无收藏歌曲' : '暂无播放历史',
              style: TextStyle(color: theme.colorScheme.onSurface.withAlpha(80)),
            ),
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
    final theme = Theme.of(context);
    final userProvider = context.watch<UserProvider>();
    if (!userProvider.isAuthenticated) {
      return _buildLoginPrompt(context);
    }

    final follows = userProvider.userFollows;
    if (follows.isEmpty) {
      return Center(child: Text('暂无关注', style: TextStyle(color: theme.colorScheme.onSurface.withAlpha(80))));
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
          title: Text(follow['singername'] ?? '', style: TextStyle(color: theme.colorScheme.onSurface)),
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
    final theme = Theme.of(context);
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Text('登录后查看关注', style: TextStyle(color: theme.colorScheme.onSurfaceVariant)),
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
    final theme = Theme.of(context);
    final userProvider = context.watch<UserProvider>();
    if (!userProvider.isAuthenticated) {
      return _buildLoginPrompt(context);
    }

    final songs = userProvider.userCloud;
    if (songs.isEmpty) {
      return Center(child: Text('云盘暂无歌曲', style: TextStyle(color: theme.colorScheme.onSurface.withAlpha(80))));
    }

    return ListView.builder(
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

  Widget _buildLoginPrompt(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Text('登录后查看云盘', style: TextStyle(color: theme.colorScheme.onSurfaceVariant)),
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



