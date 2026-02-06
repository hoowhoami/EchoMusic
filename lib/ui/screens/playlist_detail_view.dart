import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import '../../api/music_api.dart';
import '../../models/playlist.dart';
import '../../models/song.dart';
import '../../providers/audio_provider.dart';
import '../../providers/selection_provider.dart';
import '../widgets/song_card.dart';
import '../widgets/cover_image.dart';
import '../widgets/batch_action_bar.dart';

class PlaylistDetailView extends StatefulWidget {
  final Playlist playlist;
  const PlaylistDetailView({super.key, required this.playlist});

  @override
  State<PlaylistDetailView> createState() => _PlaylistDetailViewState();
}

class _PlaylistDetailViewState extends State<PlaylistDetailView> {
  late Future<List<Song>> _songsFuture;

  @override
  void initState() {
    super.initState();
    _songsFuture = MusicApi.getPlaylistSongs(
      widget.playlist.globalCollectionId ?? widget.playlist.id.toString(),
      listid: widget.playlist.listid,
      listCreateGid: widget.playlist.listCreateGid,
      listCreateUserid: widget.playlist.listCreateUserid,
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final selectionProvider = context.watch<SelectionProvider>();

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
                elevation: 0,
                automaticallyImplyLeading: false,
                flexibleSpace: FlexibleSpaceBar(
                  titlePadding: EdgeInsets.zero,
                  centerTitle: false,
                  expandedTitleScale: 1.0,
                  title: LayoutBuilder(
                    builder: (context, constraints) {
                      final double settings = constraints.maxHeight;
                      final bool isCollapsed = settings <= kToolbarHeight + 20;
                      
                      return AnimatedOpacity(
                        duration: const Duration(milliseconds: 200),
                        opacity: isCollapsed ? 1.0 : 0.0,
                        child: Container(
                          height: kToolbarHeight,
                          padding: const EdgeInsets.only(left: 20),
                          child: Row(
                            children: [
                              CoverImage(
                                url: widget.playlist.pic,
                                width: 32,
                                height: 32,
                                borderRadius: 6,
                                showShadow: false,
                              ),
                              const SizedBox(width: 12),
                              Expanded(
                                child: Text(
                                  widget.playlist.name,
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
                  ),
                  background: Padding(
                    padding: const EdgeInsets.fromLTRB(40, 20, 40, 20),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.center,
                      children: [
                        CoverImage(
                          url: widget.playlist.pic,
                          width: 140,
                          height: 140,
                          borderRadius: 12,
                        ),
                        const SizedBox(width: 32),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              Text(
                                widget.playlist.name,
                                style: theme.textTheme.titleLarge?.copyWith(
                                  fontSize: 24,
                                  fontWeight: FontWeight.w900,
                                  height: 1.2,
                                ),
                                maxLines: 2,
                                overflow: TextOverflow.ellipsis,
                              ),
                              const SizedBox(height: 10),
                              if (widget.playlist.intro.isNotEmpty)
                                Text(
                                  widget.playlist.intro,
                                  maxLines: 2,
                                  overflow: TextOverflow.ellipsis,
                                  style: theme.textTheme.bodyMedium?.copyWith(
                                    color: theme.colorScheme.onSurfaceVariant,
                                    fontWeight: FontWeight.w600,
                                    fontSize: 13,
                                  ),
                                ),
                              const SizedBox(height: 14),
                              Row(
                                children: [
                                  _buildInfoChip(context, Icons.play_arrow_rounded, _formatNumber(widget.playlist.playCount)),
                                  if (widget.playlist.heat != null) ...[
                                    const SizedBox(width: 12),
                                    _buildInfoChip(context, Icons.favorite_rounded, _formatNumber(widget.playlist.heat!)),
                                  ],
                                  const Spacer(),
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
                                ],
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
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
              FutureBuilder<List<Song>>(
                future: _songsFuture,
                builder: (context, snapshot) {
                  if (snapshot.connectionState == ConnectionState.waiting) {
                    return const SliverToBoxAdapter(
                      child: Center(child: Padding(
                        padding: EdgeInsets.all(80.0),
                        child: CupertinoActivityIndicator(),
                      )),
                    );
                  }
                  final songs = snapshot.data ?? [];
                  return SliverPadding(
                    padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 8),
                    sliver: SliverList(
                      delegate: SliverChildBuilderDelegate(
                        (context, index) {
                          final song = songs[index];
                          return SongCard(
                            song: song,
                            playlist: songs,
                            parentPlaylist: widget.playlist,
                            showMore: true,
                            isSelectionMode: selectionProvider.isSelectionMode,
                            isSelected: selectionProvider.isSelected(song.hash),
                            onSelectionChanged: (selected) {
                              selectionProvider.toggleSelection(song.hash);
                            },
                          );
                        },
                        childCount: songs.length,
                      ),
                    ),
                  );
                },
              ),
              SliverToBoxAdapter(
                child: SizedBox(
                  height: selectionProvider.isSelectionMode ? 80 : 20,
                ),
              ), // Space for BatchActionBar
            ],
          ),
          const BatchActionBar(),
        ],
      ),
    );
  }

  String _formatNumber(int number) {
    if (number < 10000) return number.toString();
    return '${(number / 10000).toStringAsFixed(1)}万';
  }

  Widget _buildInfoChip(BuildContext context, IconData icon, String label) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: theme.colorScheme.onSurface.withAlpha(15),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 12, color: theme.colorScheme.onSurfaceVariant),
          const SizedBox(width: 6),
          Text(
            label,
            style: TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w700,
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
        ],
      ),
    );
  }
}