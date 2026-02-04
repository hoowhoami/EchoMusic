import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import '../../api/music_api.dart';
import '../../models/song.dart';
import 'package:provider/provider.dart';
import '../../providers/audio_provider.dart';
import '../../providers/user_provider.dart';
import 'package:cached_network_image/cached_network_image.dart';
import '../widgets/song_card.dart';

class ArtistDetailView extends StatefulWidget {
  final int artistId;
  final String artistName;
  const ArtistDetailView({super.key, required this.artistId, required this.artistName});

  @override
  State<ArtistDetailView> createState() => _ArtistDetailViewState();
}

class _ArtistDetailViewState extends State<ArtistDetailView> {
  late Future<Map<String, dynamic>?> _detailFuture;
  late Future<List<Song>> _songsFuture;

  @override
  void initState() {
    super.initState();
    _detailFuture = MusicApi.getSingerDetail(widget.artistId);
    _songsFuture = MusicApi.getSingerSongs(widget.artistId);
  }

  @override
  Widget build(BuildContext context) {
    final userProvider = context.watch<UserProvider>();
    final isFollowing = userProvider.isFollowingSinger(widget.artistId);
    final isDark = Theme.of(context).brightness == Brightness.dark;

    return Scaffold(
      backgroundColor: Colors.transparent,
      body: CustomScrollView(
        slivers: [
          SliverAppBar(
            backgroundColor: Colors.transparent,
            expandedHeight: 380,
            flexibleSpace: FlexibleSpaceBar(
              background: FutureBuilder<Map<String, dynamic>?>(
                future: _detailFuture,
                builder: (context, snapshot) {
                  final detail = snapshot.data;
                  final String? intro = detail?['intro'];
                  final String? avatar = detail?['imgurl']?.replaceAll('{size}', '800');

                  return Stack(
                    children: [
                      if (avatar != null)
                        Positioned.fill(
                          child: CachedNetworkImage(
                            imageUrl: avatar,
                            fit: BoxFit.cover,
                          ),
                        ),
                      Container(
                        decoration: BoxDecoration(
                          gradient: LinearGradient(
                            begin: Alignment.topCenter,
                            end: Alignment.bottomCenter,
                            colors: [
                              Colors.transparent,
                              Theme.of(context).scaffoldBackgroundColor.withOpacity(0.4),
                              Theme.of(context).scaffoldBackgroundColor,
                            ],
                          ),
                        ),
                      ),
                      Padding(
                        padding: const EdgeInsets.all(40.0),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          mainAxisAlignment: MainAxisAlignment.end,
                          children: [
                            Text(
                              widget.artistName,
                              style: TextStyle(
                                fontSize: 48,
                                fontWeight: FontWeight.w800,
                                color: isDark ? Colors.white : Colors.black,
                                letterSpacing: -1.5,
                              ),
                            ),
                            const SizedBox(height: 12),
                            if (intro != null)
                              Text(
                                intro,
                                maxLines: 2,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                  color: isDark ? Colors.white70 : Colors.black54,
                                  fontSize: 15,
                                  letterSpacing: -0.2,
                                ),
                              ),
                            const SizedBox(height: 24),
                            Row(
                              children: [
                                CupertinoButton(
                                  padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 12),
                                  color: isDark ? Colors.white : Colors.black,
                                  borderRadius: BorderRadius.circular(10),
                                  onPressed: () async {
                                    final songs = await _songsFuture;
                                    if (songs.isNotEmpty) {
                                      context.read<AudioProvider>().playSong(songs.first, playlist: songs);
                                    }
                                  },
                                  child: Row(
                                    mainAxisSize: MainAxisSize.min,
                                    children: [
                                      Icon(CupertinoIcons.play_fill, color: isDark ? Colors.black : Colors.white, size: 18),
                                      const SizedBox(width: 8),
                                      Text('播放全部', style: TextStyle(color: isDark ? Colors.black : Colors.white, fontWeight: FontWeight.w600)),
                                    ],
                                  ),
                                ),
                                const SizedBox(width: 16),
                                CupertinoButton(
                                  padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 12),
                                  color: isDark ? Colors.white.withAlpha(20) : Colors.black.withAlpha(10),
                                  borderRadius: BorderRadius.circular(10),
                                  onPressed: () {
                                    if (isFollowing) {
                                      userProvider.unfollowSinger(widget.artistId);
                                    } else {
                                      userProvider.followSinger(widget.artistId);
                                    }
                                  },
                                  child: Row(
                                    mainAxisSize: MainAxisSize.min,
                                    children: [
                                      Icon(isFollowing ? CupertinoIcons.check_mark : CupertinoIcons.add, color: isDark ? Colors.white : Colors.black, size: 18),
                                      const SizedBox(width: 8),
                                      Text(isFollowing ? '已关注' : '关注', style: TextStyle(color: isDark ? Colors.white : Colors.black, fontWeight: FontWeight.w600)),
                                    ],
                                  ),
                                ),
                              ],
                            ),
                          ],
                        ),
                      ),
                    ],
                  );
                },
              ),
            ),
          ),
          FutureBuilder<List<Song>>(
            future: _songsFuture,
            builder: (context, snapshot) {
              if (snapshot.connectionState == ConnectionState.waiting) {
                return const SliverToBoxAdapter(
                  child: Center(child: Padding(
                    padding: EdgeInsets.all(40.0),
                    child: CupertinoActivityIndicator(),
                  )),
                );
              }
              final songs = snapshot.data ?? [];
              return SliverList(
                delegate: SliverChildBuilderDelegate(
                  (context, index) {
                    return Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 28),
                      child: SongCard(
                        song: songs[index],
                        playlist: songs,
                        showMore: true,
                      ),
                    );
                  },
                  childCount: songs.length,
                ),
              );
            },
          ),
          const SliverToBoxAdapter(child: SizedBox(height: 100)),
        ],
      ),
    );
  }
}
