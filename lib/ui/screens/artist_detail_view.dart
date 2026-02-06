import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import '../../api/music_api.dart';
import '../../models/song.dart';
import 'package:provider/provider.dart';
import '../../providers/audio_provider.dart';
import '../../providers/user_provider.dart';
import '../../providers/selection_provider.dart';
import 'package:cached_network_image/cached_network_image.dart';
import '../widgets/song_card.dart';
import '../widgets/batch_action_bar.dart';
import '../widgets/cover_image.dart';

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
    final selectionProvider = context.watch<SelectionProvider>();
    final isFollowing = userProvider.isFollowingSinger(widget.artistId);
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
                      final String? avatar = snapshot.data?['imgurl'];
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
                                  if (avatar != null)
                                    CoverImage(
                                      url: avatar,
                                      width: 32,
                                      height: 32,
                                      borderRadius: 16, // 圆形头像
                                      showShadow: false,
                                    ),
                                  const SizedBox(width: 12),
                                  Expanded(
                                    child: Text(
                                      widget.artistName,
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
                      final String? avatar = detail?['imgurl']?.replaceAll('{size}', '400');

                      return Container(
                        padding: const EdgeInsets.fromLTRB(40, 20, 40, 20),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.center,
                          children: [
                            if (avatar != null)
                              Container(
                                decoration: BoxDecoration(
                                  shape: BoxShape.circle,
                                  boxShadow: [
                                    BoxShadow(
                                      color: theme.colorScheme.shadow.withAlpha(50),
                                      blurRadius: 20,
                                      offset: const Offset(0, 10),
                                    ),
                                  ],
                                ),
                                child: ClipOval(
                                  child: CachedNetworkImage(
                                    imageUrl: avatar,
                                    width: 140,
                                    height: 140,
                                    fit: BoxFit.cover,
                                  ),
                                ),
                              )
                            else
                              Container(
                                width: 140,
                                height: 140,
                                decoration: BoxDecoration(
                                  color: theme.colorScheme.surfaceContainerHighest,
                                  shape: BoxShape.circle,
                                ),
                                child: Icon(CupertinoIcons.person_fill, size: 52, color: theme.colorScheme.onSurfaceVariant),
                              ),
                            const SizedBox(width: 32),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                mainAxisAlignment: MainAxisAlignment.center,
                                children: [
                                  Text(
                                    'ARTIST',
                                    style: TextStyle(
                                      color: theme.colorScheme.primary,
                                      fontSize: 11,
                                      fontWeight: FontWeight.w900,
                                      letterSpacing: 2.0,
                                    ),
                                  ),
                                  const SizedBox(height: 8),
                                  Text(
                                    widget.artistName,
                                    style: theme.textTheme.titleLarge?.copyWith(
                                      fontSize: 24,
                                      fontWeight: FontWeight.w900,
                                      height: 1.1,
                                    ),
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                  ),
                                  const SizedBox(height: 10),
                                  if (detail != null)
                                    Text(
                                      '${detail['song_count'] ?? 0} 首歌曲 • ${detail['album_count'] ?? 0} 张专辑 • ${detail['fansnums'] ?? 0} 粉丝',
                                      style: TextStyle(
                                        color: theme.colorScheme.onSurfaceVariant,
                                        fontSize: 14,
                                        fontWeight: FontWeight.w600,
                                      ),
                                    ),
                                  const SizedBox(height: 16),
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
                                        label: const Text('播放热门'),
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
                                        onPressed: () {
                                          if (isFollowing) {
                                            userProvider.unfollowSinger(widget.artistId);
                                          } else {
                                            userProvider.followSinger(widget.artistId);
                                          }
                                        },
                                        icon: Icon(isFollowing ? CupertinoIcons.check_mark : CupertinoIcons.add, size: 16),
                                        label: Text(isFollowing ? '已关注' : '关注'),
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
                    final String? bio = detail?['long_intro'] ?? detail?['intro'];
                    if (bio == null || bio.isEmpty) return const SizedBox.shrink();

                    return Padding(
                      padding: const EdgeInsets.fromLTRB(40, 10, 40, 20),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            '歌手简介',
                            style: theme.textTheme.titleMedium?.copyWith(
                              fontWeight: FontWeight.w800,
                              fontSize: 16,
                            ),
                          ),
                          const SizedBox(height: 8),
                          Text(
                            bio,
                            style: theme.textTheme.bodyMedium?.copyWith(
                              color: theme.colorScheme.onSurfaceVariant,
                              height: 1.6,
                              fontWeight: FontWeight.w500,
                            ),
                            maxLines: 3,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ],
                      ),
                    );
                  },
                ),
              ),
              SliverToBoxAdapter(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(40, 0, 40, 12),
                  child: Text(
                    '热门歌曲',
                    style: theme.textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w800,
                      fontSize: 16,
                    ),
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