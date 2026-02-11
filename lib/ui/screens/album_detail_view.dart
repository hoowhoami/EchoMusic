import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import '../../api/music_api.dart';
import '../../models/album.dart';
import '../../models/song.dart';
import '../../providers/audio_provider.dart';
import '../../providers/selection_provider.dart';
import '../../providers/refresh_provider.dart';
import '../widgets/song_card.dart';
import '../widgets/batch_action_bar.dart';
import '../widgets/cover_image.dart';
import '../widgets/custom_dialog.dart';

class AlbumDetailView extends StatefulWidget {
  final int albumId;
  final String albumName;
  const AlbumDetailView({super.key, required this.albumId, required this.albumName});

  @override
  State<AlbumDetailView> createState() => _AlbumDetailViewState();
}

class _AlbumDetailViewState extends State<AlbumDetailView> with RefreshableState {
  late Future<Album?> _detailFuture;
  late Future<List<Song>> _songsFuture;
  bool _isIntroExpanded = false;

  @override
  void initState() {
    super.initState();
    _loadData();
  }

  @override
  void onRefresh() {
    setState(() {
      _loadData();
    });
  }

  void _loadData() {
    _detailFuture = MusicApi.getAlbumDetail(widget.albumId).then((json) => json != null ? Album.fromDetailJson(json) : null);
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
                expandedHeight: 280,
                pinned: true,
                automaticallyImplyLeading: false,
                elevation: 0,
                flexibleSpace: FlexibleSpaceBar(
                  titlePadding: EdgeInsets.zero,
                  centerTitle: false,
                  expandedTitleScale: 1.0,
                  title: FutureBuilder<Album?>(
                    future: _detailFuture,
                    builder: (context, snapshot) {
                      final album = snapshot.data;
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
                                  if (album != null)
                                    CoverImage(
                                      url: album.pic,
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
                  background: FutureBuilder<Album?>(
                    future: _detailFuture,
                    builder: (context, snapshot) {
                      final album = snapshot.data;

                      return Container(
                        padding: const EdgeInsets.fromLTRB(40, 20, 40, 20),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.center,
                          children: [
                            CoverImage(
                              url: album?.pic ?? '',
                              width: 150,
                              height: 150,
                              borderRadius: 16,
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
                                      fontSize: 10,
                                      fontWeight: FontWeight.w900,
                                      letterSpacing: 2.0,
                                    ),
                                  ),
                                  const SizedBox(height: 4),
                                  Text(
                                    widget.albumName,
                                    style: theme.textTheme.titleLarge?.copyWith(
                                      fontSize: 26,
                                      fontWeight: FontWeight.w900,
                                      height: 1.1,
                                    ),
                                    maxLines: 2,
                                    overflow: TextOverflow.ellipsis,
                                  ),
                                  const SizedBox(height: 10),
                                  if (album != null)
                                    Column(
                                      crossAxisAlignment: CrossAxisAlignment.start,
                                      children: [
                                        Text(
                                          '${album.singerName} • ${album.publishTime}',
                                          style: TextStyle(
                                            color: theme.colorScheme.onSurfaceVariant, 
                                            fontSize: 14,
                                            fontWeight: FontWeight.w700,
                                          ),
                                          maxLines: 1,
                                          overflow: TextOverflow.ellipsis,
                                        ),
                                        const SizedBox(height: 4),
                                        Row(
                                          children: [
                                            _buildInfoSmall(context, Icons.favorite_rounded, _formatNumber(album.heat)),
                                            if (album.language.isNotEmpty || album.type.isNotEmpty) ...[
                                              const SizedBox(width: 12),
                                              if (album.language.isNotEmpty) ...[
                                                _buildTag(context, album.language),
                                                const SizedBox(width: 8),
                                              ],
                                              if (album.type.isNotEmpty) ...[
                                                _buildTag(context, album.type),
                                                const SizedBox(width: 8),
                                              ],
                                            ],
                                          ],
                                        ),
                                        if (album.company.isNotEmpty) ...[
                                          const SizedBox(height: 6),
                                          Text(
                                            '发行公司: ${album.company}',
                                            style: TextStyle(
                                              color: theme.colorScheme.onSurfaceVariant.withAlpha(150),
                                              fontSize: 11,
                                              fontWeight: FontWeight.w500,
                                            ),
                                            maxLines: 1,
                                            overflow: TextOverflow.ellipsis,
                                          ),
                                        ],
                                      ],
                                    ),
                                  const SizedBox(height: 16),
                                  Row(
                                    children: [
                                      OutlinedButton.icon(
                                        onPressed: () async {
                                          final songs = await _songsFuture;
                                          if (songs.isNotEmpty) {
                                            context.read<AudioProvider>().playSong(songs.first, playlist: songs);
                                          }
                                        },
                                        icon: Icon(CupertinoIcons.play_fill, size: 16, color: theme.colorScheme.primary),
                                        label: Text('播放专辑', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: theme.colorScheme.primary)),
                                        style: OutlinedButton.styleFrom(
                                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                                          side: BorderSide(color: theme.colorScheme.primary.withAlpha(100)),
                                          padding: const EdgeInsets.symmetric(horizontal: 16),
                                          minimumSize: const Size(0, 40),
                                          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                                        ),
                                      ),
                                      const SizedBox(width: 12),
                                      OutlinedButton.icon(
                                        onPressed: () {},
                                        icon: const Icon(CupertinoIcons.heart, size: 16),
                                        label: const Text('收藏', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700)),
                                        style: OutlinedButton.styleFrom(
                                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                                          side: BorderSide(color: theme.colorScheme.outlineVariant),
                                          padding: const EdgeInsets.symmetric(horizontal: 16),
                                          minimumSize: const Size(0, 40),
                                          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
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
                        margin: const EdgeInsets.symmetric(vertical: 8),
                        child: TextButton.icon(
                          onPressed: () {
                            selectionProvider.setSongList(snapshot.data!, playlistId: widget.albumId);
                            selectionProvider.enterSelectionMode();
                          },
                          icon: const Icon(CupertinoIcons.checkmark_circle, size: 16),
                          label: const Text('批量选择', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 13)),
                          style: TextButton.styleFrom(
                            foregroundColor: theme.colorScheme.onSurface,
                            backgroundColor: theme.colorScheme.onSurface.withAlpha(20),
                            padding: const EdgeInsets.symmetric(horizontal: 16),
                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
                            minimumSize: const Size(0, 40),
                            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                          ),
                        ),
                      );
                    },
                  ),
                  const SizedBox(width: 20),
                ],
              ),
              SliverToBoxAdapter(
                child: FutureBuilder<Album?>(
                  future: _detailFuture,
                  builder: (context, snapshot) {
                    final album = snapshot.data;
                    final String? intro = album?.intro;

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
                            maxLines: 3,
                            overflow: TextOverflow.ellipsis,
                            style: theme.textTheme.bodyMedium?.copyWith(
                              color: theme.colorScheme.onSurfaceVariant,
                              height: 1.6,
                              fontWeight: FontWeight.w500,
                            ),
                          ),
                          if (intro.length > 100)
                            InkWell(
                              onTap: () {
                                CustomDialog.show(
                                  context,
                                  title: '专辑介绍',
                                  content: intro,
                                  confirmText: '确定',
                                  showCancel: false,
                                  width: 600,
                                );
                              },
                              hoverColor: Colors.transparent,
                              splashColor: Colors.transparent,
                              highlightColor: Colors.transparent,
                              child: Padding(
                                padding: const EdgeInsets.symmetric(vertical: 4),
                                child: Text(
                                  '查看详情',
                                  style: TextStyle(
                                    color: theme.colorScheme.primary,
                                    fontSize: 12,
                                    fontWeight: FontWeight.w700,
                                  ),
                                ),
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

  Widget _buildTag(BuildContext context, String label) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: theme.colorScheme.primary.withAlpha(20),
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: theme.colorScheme.primary.withAlpha(50), width: 0.5),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontSize: 10,
          fontWeight: FontWeight.w700,
          color: theme.colorScheme.primary,
        ),
      ),
    );
  }

  String _formatNumber(int number) {
    if (number < 10000) return number.toString();
    return '${(number / 10000).toStringAsFixed(1)}万';
  }

  Widget _buildInfoSmall(BuildContext context, IconData icon, String label) {
    final theme = Theme.of(context);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 12, color: theme.colorScheme.onSurfaceVariant.withAlpha(180)),
        const SizedBox(width: 4),
        Text(
          label,
          style: TextStyle(
            fontSize: 11,
            fontWeight: FontWeight.w600,
            color: theme.colorScheme.onSurfaceVariant.withAlpha(180),
          ),
        ),
      ],
    );
  }
}