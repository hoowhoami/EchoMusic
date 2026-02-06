import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import '../../api/music_api.dart';
import '../../models/song.dart';
import 'package:provider/provider.dart';
import '../../providers/audio_provider.dart';
import '../../providers/user_provider.dart';
import 'package:cached_network_image/cached_network_image.dart';
import '../widgets/cover_image.dart';
import '../widgets/custom_toast.dart';
import '../widgets/song_list_scaffold.dart';

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
    final theme = Theme.of(context);

    return FutureBuilder<List<Song>>(
      future: _songsFuture,
      builder: (context, snapshot) {
        final songs = snapshot.data ?? [];
        final isLoading = snapshot.connectionState == ConnectionState.waiting;

        return SongListScaffold(
          songs: songs,
          isLoading: isLoading,
          sourceId: widget.artistId,
          headers: [
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
                                    OutlinedButton.icon(
                                      onPressed: () async {
                                        final songs = await _songsFuture;
                                        if (songs.isNotEmpty) {
                                          context.read<AudioProvider>().playSong(songs.first, playlist: songs);
                                        }
                                      },
                                      icon: Icon(CupertinoIcons.play_fill, size: 16, color: theme.colorScheme.primary),
                                      label: Text('播放热门', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: theme.colorScheme.primary)),
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
                                      onPressed: () async {
                                        bool success;
                                        if (isFollowing) {
                                          success = await userProvider.unfollowSinger(widget.artistId);
                                          if (context.mounted) {
                                            if (success) {
                                              CustomToast.success(context, '已取消关注');
                                            } else {
                                              CustomToast.error(context, '操作失败');
                                            }
                                          }
                                        } else {
                                          success = await userProvider.followSinger(widget.artistId);
                                          if (context.mounted) {
                                            if (success) {
                                              CustomToast.success(context, '关注成功');
                                            } else {
                                              CustomToast.error(context, '关注失败');
                                            }
                                          }
                                        }
                                      },
                                      icon: Icon(isFollowing ? CupertinoIcons.check_mark : CupertinoIcons.add, size: 16),
                                      label: Text(isFollowing ? '已关注' : '关注', style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700)),
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
          ],
        );
      },
    );
  }
}