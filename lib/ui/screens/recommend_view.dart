import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:intl/intl.dart';
import '../../api/music_api.dart';
import '../../models/song.dart';
import '../../models/playlist.dart';
import 'package:provider/provider.dart';
import '../../providers/audio_provider.dart';
import '../../providers/user_provider.dart';
import 'package:cached_network_image/cached_network_image.dart';
import 'playlist_detail_view.dart';
import 'rank_view.dart';
import 'recommend_song_view.dart';

class RecommendView extends StatefulWidget {
  const RecommendView({super.key});

  @override
  State<RecommendView> createState() => _RecommendViewState();
}

class _RecommendViewState extends State<RecommendView> {
  late Future<List<Playlist>> _recommendedPlaylistsFuture;
  late Future<List<Map<String, dynamic>>> _topIpFuture;

  @override
  void initState() {
    super.initState();
    _recommendedPlaylistsFuture = MusicApi.getPlaylistByCategory('0');
    _topIpFuture = MusicApi.getTopIP();
  }

  String _getGreeting() {
    final hour = DateTime.now().hour;
    if (hour < 6) return '凌晨好';
    if (hour < 9) return '早上好';
    if (hour < 12) return '上午好';
    if (hour < 14) return '中午好';
    if (hour < 18) return '下午好';
    return '晚上好';
  }

  @override
  Widget build(BuildContext context) {
    final userProvider = context.watch<UserProvider>();
    final greeting = userProvider.isAuthenticated 
        ? 'Hi, ${userProvider.user?.nickname} ${_getGreeting()}' 
        : _getGreeting();

    return SingleChildScrollView(
      padding: const EdgeInsets.symmetric(horizontal: 40, vertical: 30),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Greeting
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                greeting,
                style: const TextStyle(
                  fontSize: 32,
                  fontWeight: FontWeight.w700,
                  letterSpacing: -0.8,
                ),
              ),
              const Text(
                '由此开启好心情 ~',
                style: TextStyle(
                  fontSize: 14,
                  color: Colors.grey,
                  letterSpacing: -0.2,
                ),
              ),
            ],
          ),
          const SizedBox(height: 32),

          // Daily Recommend & Rank Cards
          Row(
            children: [
              _buildLargeFeatureCard(
                context,
                title: '每日推荐',
                subtitle: '根据你的音乐口味生成',
                iconContent: DateTime.now().day.toString(),
                onTap: () => Navigator.push(context, CupertinoPageRoute(builder: (_) => const RecommendSongView())),
              ),
              const SizedBox(width: 20),
              _buildLargeFeatureCard(
                context,
                title: '排行榜',
                subtitle: '发现你的专属好歌',
                iconContent: 'TOP',
                onTap: () => Navigator.push(context, CupertinoPageRoute(builder: (_) => const RankView())),
              ),
            ],
          ),

          const SizedBox(height: 48),
          _buildHeader(context, '推荐歌单'),
          const SizedBox(height: 20),
          _buildRecommendedPlaylists(),

          const SizedBox(height: 48),
          _buildHeader(context, '编辑精选'),
          const SizedBox(height: 20),
          _buildIPTopPlaylists(),
          
          const SizedBox(height: 100),
        ],
      ),
    );
  }

  Widget _buildLargeFeatureCard(BuildContext context, {
    required String title,
    required String subtitle,
    required String iconContent,
    required VoidCallback onTap,
  }) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    
    return Expanded(
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(16),
        child: Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: isDark ? Colors.white.withAlpha(10) : Colors.black.withAlpha(5),
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: isDark ? Colors.white10 : Colors.black12),
          ),
          child: Row(
            children: [
              Container(
                width: 56,
                height: 56,
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: isDark ? Colors.white24 : Colors.black26, width: 2),
                ),
                child: Center(
                  child: Text(
                    iconContent,
                    style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w900),
                  ),
                ),
              ),
              const SizedBox(width: 16),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
                    ),
                    Text(
                      subtitle,
                      style: TextStyle(fontSize: 12, color: isDark ? Colors.white54 : Colors.black54),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildHeader(BuildContext context, String title) {
    return Text(
      title,
      style: const TextStyle(
        fontWeight: FontWeight.w700,
        fontSize: 22,
        letterSpacing: -0.5,
      ),
    );
  }

  Widget _buildRecommendedPlaylists() {
    return FutureBuilder<List<Playlist>>(
      future: _recommendedPlaylistsFuture,
      builder: (context, snapshot) {
        if (!snapshot.hasData) return const SizedBox(height: 240);
        final playlists = snapshot.data!;
        return SizedBox(
          height: 250,
          child: ListView.builder(
            scrollDirection: Axis.horizontal,
            itemCount: playlists.length,
            padding: EdgeInsets.zero,
            itemBuilder: (context, index) {
              final playlist = playlists[index];
              return Padding(
                padding: const EdgeInsets.only(right: 24),
                child: _buildPlaylistCard(playlist),
              );
            },
          ),
        );
      },
    );
  }

  Widget _buildIPTopPlaylists() {
    return FutureBuilder<List<Map<String, dynamic>>>(
      future: _topIpFuture,
      builder: (context, snapshot) {
        if (!snapshot.hasData) return const SizedBox(height: 240);
        // Legacy: res?.list?.filter((item: IP) => item.type === 1 && item.extra?.global_collection_id)
        final ipList = snapshot.data!.where((item) => 
          item['type'] == 1 && item['extra']?['global_collection_id'] != null
        ).toList();

        return SizedBox(
          height: 250,
          child: ListView.builder(
            scrollDirection: Axis.horizontal,
            itemCount: ipList.length,
            padding: EdgeInsets.zero,
            itemBuilder: (context, index) {
              final ip = ipList[index];
              final playlist = Playlist.fromJson({
                'specialname': ip['title'],
                'flexible_cover': ip['pic'],
                'global_collection_id': ip['extra']['global_collection_id'],
              });
              return Padding(
                padding: const EdgeInsets.only(right: 24),
                child: _buildPlaylistCard(playlist, subtitle: '编辑精选'),
              );
            },
          ),
        );
      },
    );
  }

  Widget _buildPlaylistCard(Playlist playlist, {String subtitle = '为您推荐'}) {
    return InkWell(
      onTap: () {
        Navigator.push(
          context,
          CupertinoPageRoute(
            builder: (_) => PlaylistDetailView(playlist: playlist),
          ),
        );
      },
      borderRadius: BorderRadius.circular(10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(10),
              boxShadow: [
                BoxShadow(
                  color: Colors.black.withAlpha(30),
                  blurRadius: 10,
                  offset: const Offset(0, 4),
                ),
              ],
            ),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(10),
              child: CachedNetworkImage(
                imageUrl: playlist.pic,
                width: 170,
                height: 170,
                fit: BoxFit.cover,
              ),
            ),
          ),
          const SizedBox(height: 12),
          SizedBox(
            width: 170,
            child: Text(
              playlist.name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontWeight: FontWeight.w600,
                fontSize: 14,
                letterSpacing: -0.2,
              ),
            ),
          ),
          Text(
            subtitle,
            style: TextStyle(
              color: Theme.of(context).brightness == Brightness.dark ? Colors.white38 : Colors.black38,
              fontSize: 12,
            ),
          ),
        ],
      ),
    );
  }
}