import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import '../../api/music_api.dart';
import '../../models/song.dart';
import '../../providers/audio_provider.dart';
import '../../providers/selection_provider.dart';
import '../widgets/song_card.dart';
import '../widgets/batch_action_bar.dart';
import '../widgets/cover_image.dart';

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
      body: Stack(
        children: [
          CustomScrollView(
            physics: const BouncingScrollPhysics(),
            slivers: [
              SliverAppBar(
                backgroundColor: theme.scaffoldBackgroundColor,
                surfaceTintColor: Colors.transparent,
                expandedHeight: 200,
                pinned: true,
                automaticallyImplyLeading: false,
                elevation: 0,
                flexibleSpace: FlexibleSpaceBar(
                  titlePadding: EdgeInsets.zero,
                  centerTitle: false,
                  expandedTitleScale: 1.0,
                  title: FutureBuilder<Map<String, dynamic>?>(
                    future: _detailFuture,
                    builder: (context, snapshot) {
                      final String? cover = snapshot.data?['img'] ?? snapshot.data?['imgurl'];
                      return LayoutBuilder(
                        builder: (context, constraints) {
                          final bool isCollapsed = constraints.maxHeight <= kToolbarHeight + 20;
                          return AnimatedOpacity(
                            duration: const Duration(milliseconds: 200),
                            opacity: isCollapsed ? 1.0 : 0.0,
                            child: Container(
                              height: kToolbarHeight,
                              padding: const EdgeInsets.only(left: 20),
                              child: Row(
                                children: [
                                  if (cover != null)
                                    CoverImage(
                                      url: cover,
                                      width: 32,
                                      height: 32,
                                      borderRadius: 6,
                                      showShadow: false,
                                    ),
                                  const SizedBox(width: 12),
                                  Expanded(
                                    child: Text(
                                      widget.albumName,
                                      style: TextStyle(
                                        color: theme.colorScheme.onSurface,
                                        fontSize: 16,
                                        fontWeight: FontWeight.w900,
                                      ),
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          );
                        },
                      );
                    },
                  ),
                  background: FutureBuilder<Map<String, dynamic>?>(
                    future: _detailFuture,
                    builder: (context, snapshot) {
                      final detail = snapshot.data;
                      final String? cover = detail?['img']?.replaceAll('{size}', '400') ?? detail?['imgurl']?.replaceAll('{size}', '400');

                      return Container(
                        padding: const EdgeInsets.fromLTRB(40, 20, 40, 20),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.center,
                          children: [
                            if (cover != null)
                              CoverImage(
                                url: cover,
                                width: 140,
                                height: 140,
                                borderRadius: 12,
                              )
                            else
                              Container(
                                width: 140,
                                height: 140,
                                decoration: BoxDecoration(
                                  color: theme.colorScheme.surfaceContainerHighest,
                                  borderRadius: BorderRadius.circular(12),
                                ),
                                child: Icon(CupertinoIcons.music_albums, size: 52, color: theme.colorScheme.onSurfaceVariant),
                              ),
                            const SizedBox(width: 32),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                mainAxisAlignment: MainAxisAlignment.center,
                                children: [
                                  Text(
                                    'ALBUM',
                                    style: TextStyle(
                                      color: theme.colorScheme.primary,
                                      fontSize: 11,
                                      fontWeight: FontWeight.w900,
                                      letterSpacing: 2.0,
                                    ),
                                  ),
                                  const SizedBox(height: 8),
                                  Text(
                                    widget.albumName,
                                    style: theme.textTheme.titleLarge?.copyWith(
                                      fontSize: 24,
                                      fontWeight: FontWeight.w900,
                                      height: 1.2,
                                    ),
                                    maxLines: 2,
                                    overflow: TextOverflow.ellipsis,
                                  ),
                                  const SizedBox(height: 10),
                                  if (detail != null)
                                    Text(
                                      '${detail['singername'] ?? detail['singer'] ?? ''} • ${detail['publishtime'] ?? detail['publish_time'] ?? ''}',
                                      style: TextStyle(
                                        color: theme.colorScheme.onSurfaceVariant, 
                                        fontSize: 13,
                                        fontWeight: FontWeight.w600,
                                      ),
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                    ),
                                  const SizedBox(height: 14),
                                  Row(
                                    children: [
                                      ElevatedButton.icon(
                                        onPressed: () async {
                                          final songs = await _songsFuture;
                                          if (songs.isNotEmpty) {
                                            context.read<AudioProvider>().playSong(songs.first, playlist: songs);
                                          }
                                        },
                                        icon: const Icon(CupertinoIcons.play_fill, size: 16),
                                        label: const Text('播放'),
                                        style: ElevatedButton.styleFrom(
                                          backgroundColor: theme.colorScheme.primary,
                                          foregroundColor: theme.colorScheme.onPrimary,
                                          elevation: 8,
                                          shadowColor: theme.colorScheme.primary.withAlpha(80),
                                          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 10),
                                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                                        ),
                                      ),
                                      const SizedBox(width: 12),
                                      OutlinedButton.icon(
                                        onPressed: () {},
                                        icon: const Icon(CupertinoIcons.heart, size: 16),
                                        label: const Text('收藏'),
                                        style: OutlinedButton.styleFrom(
                                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                                          side: BorderSide(color: theme.colorScheme.outlineVariant),
                                          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                                        ),
                                      ),
                                    ],
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                      );
                    },
                  ),
                ),
                actions: [
                  FutureBuilder<List<Song>>(
                    future: _songsFuture,
                    builder: (context, snapshot) {
                      if (!snapshot.hasData || snapshot.data!.isEmpty) return const SizedBox.shrink();
                      if (selectionProvider.isSelectionMode) return const SizedBox.shrink();
                      return Container(
                        margin: const EdgeInsets.symmetric(vertical: 10),
                        child: TextButton.icon(
                          onPressed: () {
                            selectionProvider.setSongList(snapshot.data!);
                            selectionProvider.enterSelectionMode();
                          },
                          icon: const Icon(CupertinoIcons.checkmark_circle, size: 16),
                          label: const Text('批量选择', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 13)),
                          style: TextButton.styleFrom(
                            foregroundColor: theme.colorScheme.onSurface,
                            backgroundColor: theme.colorScheme.onSurface.withAlpha(20),
                            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                          ),
                        ),
                      );
                    },
                  ),
                  const SizedBox(width: 20),
                ],
              ),
              SliverToBoxAdapter(
                child: FutureBuilder<Map<String, dynamic>?>(
                  future: _detailFuture,
                  builder: (context, snapshot) {
                    final detail = snapshot.data;
                    final String? intro = detail?['intro'];

                    if (intro == null || intro.isEmpty) return const SizedBox.shrink();

                    return Padding(
                      padding: const EdgeInsets.fromLTRB(40, 10, 40, 20),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            '专辑介绍',
                            style: theme.textTheme.titleMedium?.copyWith(
                              fontWeight: FontWeight.w800,
                              fontSize: 16,
                            ),
                          ),
                          const SizedBox(height: 8),
                          Text(
                            intro,
                            style: theme.textTheme.bodyMedium?.copyWith(
                              color: theme.colorScheme.onSurfaceVariant,
                              height: 1.6,
                              fontWeight: FontWeight.w500,
                            ),
                          ),
                        ],
                      ),
                    );
                  },
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
                          padding: const EdgeInsets.symmetric(horizontal: 24),
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
              SliverToBoxAdapter(
                child: SizedBox(
                  height: selectionProvider.isSelectionMode ? 80 : 20,
                ),
              ),
            ],
          ),
          const BatchActionBar(),
        ],
      ),
    );
  }
}