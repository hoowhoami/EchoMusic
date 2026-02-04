import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:intl/intl.dart';
import '../../api/music_api.dart';
import '../../models/song.dart';
import '../../models/playlist.dart';
import 'package:provider/provider.dart';
import '../../providers/audio_provider.dart';
import '../../providers/user_provider.dart';
import '../widgets/cover_image.dart';
import '../widgets/scrollable_content.dart';
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
    final theme = Theme.of(context);
    final userProvider = context.watch<UserProvider>();
    final greeting = userProvider.isAuthenticated
        ? 'Hi, ${userProvider.user?.nickname} ${_getGreeting()}'
        : _getGreeting();

    return ScrollableContent(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Greeting
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                greeting,
                style: theme.textTheme.titleLarge?.copyWith(fontSize: 22, letterSpacing: -0.5),
              ),
              const SizedBox(height: 4),
              Text(
                '由此开启好心情 ~',
                style: theme.textTheme.bodyMedium?.copyWith(fontSize: 12),
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
                subtitle: '为你量身定制',
                iconContent: DateTime.now().day.toString(),
                onTap: () => Navigator.push(context, CupertinoPageRoute(builder: (_) => const RecommendSongView())),
                color: Theme.of(context).colorScheme.primary,
              ),
              const SizedBox(width: 16),
              _buildLargeFeatureCard(
                context,
                title: '排行榜',
                subtitle: '实时热门趋势',
                iconContent: 'TOP',
                onTap: () => Navigator.push(context, CupertinoPageRoute(builder: (_) => const RankView())),
                color: Theme.of(context).colorScheme.secondary,
              ),
            ],
          ),

          const SizedBox(height: 40),
          _buildHeader(context, '推荐歌单'),
          const SizedBox(height: 16),
          _buildRecommendedPlaylists(),

          const SizedBox(height: 40),
          _buildHeader(context, '编辑精选'),
          const SizedBox(height: 16),
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
    required Color color,
  }) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final theme = Theme.of(context);
    
    return Expanded(
      child: Container(
        height: 72,
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: isDark ? Colors.white.withAlpha(5) : Colors.black.withAlpha(5)),
        ),
        child: Material(
          color: isDark ? Colors.white.withAlpha(5) : Colors.white,
          borderRadius: BorderRadius.circular(16),
          child: InkWell(
            onTap: onTap,
            borderRadius: BorderRadius.circular(16),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Row(
                children: [
                  Container(
                    width: 40,
                    height: 40,
                    decoration: BoxDecoration(
                      gradient: LinearGradient(
                        colors: [color, color.withAlpha(180)],
                        begin: Alignment.topLeft,
                        end: Alignment.bottomRight,
                      ),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: Center(
                      child: Text(
                        iconContent,
                        style: const TextStyle(
                          fontSize: 16, 
                          fontWeight: FontWeight.w900, 
                          color: Colors.white,
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Text(
                          title,
                          style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700),
                        ),
                        Text(
                          subtitle,
                          style: theme.textTheme.bodyMedium?.copyWith(fontSize: 11),
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
        ),
      ),
    );
  }

  Widget _buildHeader(BuildContext context, String title) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Text(
          title,
          style: Theme.of(context).textTheme.titleMedium?.copyWith(fontSize: 15),
        ),
        TextButton(
          onPressed: () {},
          style: TextButton.styleFrom(
            padding: const EdgeInsets.symmetric(horizontal: 8),
            minimumSize: Size.zero,
            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          ),
          child: Text(
            '更多',
            style: TextStyle(
              color: Theme.of(context).colorScheme.primary,
              fontWeight: FontWeight.w600,
              fontSize: 12,
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildRecommendedPlaylists() {
    return FutureBuilder<List<Playlist>>(
      future: _recommendedPlaylistsFuture,
      builder: (context, snapshot) {
        if (!snapshot.hasData) return const SizedBox(height: 200);
        final playlists = snapshot.data!;
        return SizedBox(
          height: 210,
          child: ListView.builder(
            scrollDirection: Axis.horizontal,
            itemCount: playlists.length,
            physics: const BouncingScrollPhysics(),
            padding: EdgeInsets.zero,
            itemBuilder: (context, index) {
              final playlist = playlists[index];
              return Padding(
                padding: const EdgeInsets.only(right: 20),
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
        if (!snapshot.hasData) return const SizedBox(height: 200);
        final ipList = snapshot.data!.where((item) => 
          item['type'] == 1 && item['extra']?['global_collection_id'] != null
        ).toList();

        return SizedBox(
          height: 210,
          child: ListView.builder(
            scrollDirection: Axis.horizontal,
            itemCount: ipList.length,
            physics: const BouncingScrollPhysics(),
            padding: EdgeInsets.zero,
            itemBuilder: (context, index) {
              final ip = ipList[index];
              final playlist = Playlist.fromJson({
                'specialname': ip['title'],
                'flexible_cover': ip['pic'],
                'global_collection_id': ip['extra']['global_collection_id'],
              });
              return Padding(
                padding: const EdgeInsets.only(right: 20),
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
      borderRadius: BorderRadius.circular(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          CoverImage(
            url: playlist.pic,
            width: 140,
            height: 140,
            borderRadius: 12,
            showShadow: false,
          ),
          const SizedBox(height: 10),
          SizedBox(
            width: 140,
            child: Text(
              playlist.name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontWeight: FontWeight.w600,
                fontSize: 13,
              ),
            ),
          ),
          const SizedBox(height: 2),
          Text(
            subtitle,
            style: Theme.of(context).textTheme.bodyMedium?.copyWith(fontSize: 11),
          ),
        ],
      ),
    );
  }
}