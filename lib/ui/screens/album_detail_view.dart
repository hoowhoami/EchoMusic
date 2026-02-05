import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import '../../api/music_api.dart';
import '../../models/song.dart';
import '../../providers/selection_provider.dart';
import 'package:cached_network_image/cached_network_image.dart';
import '../widgets/song_card.dart';
import '../widgets/batch_action_bar.dart';

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
    final selectionProvider = context.watch<SelectionProvider>();

    final theme = Theme.of(context);

    return Scaffold(
      backgroundColor: theme.scaffoldBackgroundColor,
      body: Column(
        children: [
          Expanded(
            child: CustomScrollView(
              slivers: [
                SliverAppBar(
                  backgroundColor: Colors.transparent,
                  expandedHeight: 300,
                  automaticallyImplyLeading: false,
                  actions: [
                    FutureBuilder<List<Song>>(
                      future: _songsFuture,
                      builder: (context, snapshot) {
                        if (!snapshot.hasData || snapshot.data!.isEmpty) {
                          return const SizedBox.shrink();
                        }
                        if (selectionProvider.isSelectionMode) {
                          return const SizedBox.shrink();
                        }
                        return IconButton(
                          icon: const Icon(CupertinoIcons.checkmark_circle, size: 22),
                          onPressed: () {
                            selectionProvider.setSongList(snapshot.data!);
                            selectionProvider.enterSelectionMode();
                          },
                          color: theme.colorScheme.onSurfaceVariant,
                          tooltip: '批量选择',
                        );
                      },
                    ),
                  ],
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
                                    theme.scaffoldBackgroundColor.withAlpha(200),
                                    theme.scaffoldBackgroundColor,
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
                                            color: theme.colorScheme.shadow.withAlpha(50),
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
                                      mainAxisSize: MainAxisSize.min,
                                      children: [
                                        Text(
                                          '专辑',
                                          style: TextStyle(
                                            color: theme.colorScheme.onSurfaceVariant,
                                            fontSize: 14,
                                            fontWeight: FontWeight.w700,
                                            letterSpacing: 1.5,
                                          ),
                                        ),
                                        Text(
                                          widget.albumName,
                                          style: TextStyle(
                                            fontSize: 32,
                                            fontWeight: FontWeight.w800,
                                            color: theme.colorScheme.onSurface,
                                            letterSpacing: -1.0,
                                          ),
                                          maxLines: 2,
                                          overflow: TextOverflow.ellipsis,
                                        ),
                                        const SizedBox(height: 8),
                                        if (detail != null)
                                          Text(
                                            '${detail['singername'] ?? detail['singer'] ?? ''} • ${detail['publishtime'] ?? detail['publish_time'] ?? ''}',
                                            style: TextStyle(
                                              color: theme.colorScheme.onSurfaceVariant, 
                                              fontSize: 15,
                                              fontWeight: FontWeight.w600,
                                            ),
                                            maxLines: 1,
                                            overflow: TextOverflow.ellipsis,
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
                          final song = songs[index];
                          return Padding(
                            padding: const EdgeInsets.symmetric(horizontal: 28),
                            child: SongCard(
                              song: song,
                              playlist: songs,
                              showMore: true,
                              isSelectionMode: selectionProvider.isSelectionMode,
                              isSelected: selectionProvider.isSelected(song.hash),
                              onSelectionChanged: (selected) {
                                selectionProvider.toggleSelection(song.hash);
                              },
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
          ),
          const BatchActionBar(),
        ],
      ),
    );
  }
}
