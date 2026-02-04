import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import '../../api/music_api.dart';
import '../../models/song.dart';
import 'package:cached_network_image/cached_network_image.dart';
import '../widgets/song_card.dart';

class AlbumDetailView extends StatefulWidget {
  final int albumId;
  final String albumName;
  const AlbumDetailView({super.key, required this.albumId, required this.albumName});

  @override
  State<AlbumDetailView> createState() => _AlbumDetailViewState();
}

class _AlbumDetailViewState extends State<AlbumDetailView> {
  late Future<Map<String, dynamic>?> _detailFuture;
  late Future<List<Song>> _songsFuture;

  @override
  void initState() {
    super.initState();
    _detailFuture = MusicApi.getAlbumDetail(widget.albumId);
    _songsFuture = MusicApi.getAlbumSongs(widget.albumId);
  }

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;

    return Scaffold(
      backgroundColor: Colors.transparent,
      body: CustomScrollView(
        slivers: [
          SliverAppBar(
            backgroundColor: Colors.transparent,
            expandedHeight: 300,
            flexibleSpace: FlexibleSpaceBar(
              background: FutureBuilder<Map<String, dynamic>?>(
                future: _detailFuture,
                builder: (context, snapshot) {
                  final detail = snapshot.data;
                  final String? cover = detail?['img']?.replaceAll('{size}', '800') ?? detail?['imgurl']?.replaceAll('{size}', '800');

                  return Stack(
                    children: [
                      if (cover != null)
                        Positioned.fill(
                          child: CachedNetworkImage(
                            imageUrl: cover,
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
                              Theme.of(context).scaffoldBackgroundColor.withOpacity(0.8),
                              Theme.of(context).scaffoldBackgroundColor,
                            ],
                          ),
                        ),
                      ),
                      Padding(
                        padding: const EdgeInsets.all(40.0),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.end,
                          children: [
                            if (cover != null)
                              Container(
                                decoration: BoxDecoration(
                                  borderRadius: BorderRadius.circular(12),
                                  boxShadow: [
                                    BoxShadow(
                                      color: Colors.black.withAlpha(50),
                                      blurRadius: 20,
                                      offset: const Offset(0, 10),
                                    ),
                                  ],
                                ),
                                child: ClipRRect(
                                  borderRadius: BorderRadius.circular(12),
                                  child: CachedNetworkImage(
                                    imageUrl: cover,
                                    width: 180,
                                    height: 180,
                                    fit: BoxFit.cover,
                                  ),
                                ),
                              ),
                            const SizedBox(width: 24),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                mainAxisAlignment: MainAxisAlignment.end,
                                children: [
                                  Text(
                                    '专辑',
                                    style: TextStyle(
                                      color: isDark ? Colors.white54 : Colors.black54,
                                      fontSize: 14,
                                      fontWeight: FontWeight.w600,
                                      letterSpacing: 1.2,
                                    ),
                                  ),
                                  Text(
                                    widget.albumName,
                                    style: TextStyle(
                                      fontSize: 32,
                                      fontWeight: FontWeight.w700,
                                      color: isDark ? Colors.white : Colors.black,
                                      letterSpacing: -0.5,
                                    ),
                                  ),
                                  const SizedBox(height: 8),
                                  if (detail != null)
                                    Text(
                                      '${detail['singername'] ?? detail['singer'] ?? ''} • ${detail['publishtime'] ?? detail['publish_time'] ?? ''}',
                                      style: TextStyle(color: isDark ? Colors.white70 : Colors.black.withOpacity(0.7), fontSize: 16),
                                    ),
                                ],
                              ),
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
