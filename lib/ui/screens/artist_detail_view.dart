import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import '../../api/music_api.dart';
import '../../models/artist.dart';
import '../../models/song.dart';
import 'package:provider/provider.dart';
import '../../providers/audio_provider.dart';
import '../../providers/user_provider.dart';
import '../../providers/refresh_provider.dart';
import 'package:cached_network_image/cached_network_image.dart';
import '../widgets/cover_image.dart';
import '../widgets/custom_toast.dart';
import '../widgets/custom_dialog.dart';
import '../widgets/song_list_scaffold.dart';

class ArtistDetailView extends StatefulWidget {
  final int artistId;
  final String artistName;
  const ArtistDetailView({super.key, required this.artistId, required this.artistName});

  @override
  State<ArtistDetailView> createState() => _ArtistDetailViewState();
}

class _ArtistDetailViewState extends State<ArtistDetailView> with RefreshableState {
  static const int _pageSize = 200;

  Artist? _artist;
  List<Song>? _songs;
  bool _isLoading = true;
  int _currentPage = 1;
  bool _hasMore = true;
  bool _isLoadingMore = false;

  int get _totalSongCount => _artist?.songCount ?? 0;

  bool _computeHasMore({required int loadedCount, required int lastPageCount}) {
    final totalSongCount = _totalSongCount;
    if (totalSongCount > 0) return loadedCount < totalSongCount;
    return lastPageCount >= _pageSize;
  }

  @override
  void initState() {
    super.initState();
    _loadData();
  }

  @override
  void onRefresh() {
    _loadData();
  }

  Future<void> _loadData() async {
    if (!mounted) return;
    setState(() {
      _isLoading = true;
      _currentPage = 1;
      _hasMore = true;
    });

    final results = await Future.wait([
      MusicApi.getSingerDetail(widget.artistId),
      _fetchSongsPage(1),
    ]);

    if (mounted) {
      setState(() {
        final artistJson = results[0] as Map<String, dynamic>?;
        if (artistJson != null) {
          _artist = Artist.fromDetailJson(artistJson);
        }
        final songs = results[1] as List<Song>?;
        _songs = songs;
        _isLoading = false;
        final loadedCount = songs?.length ?? 0;
        _hasMore = _computeHasMore(loadedCount: loadedCount, lastPageCount: loadedCount);
      });
    }
  }

  Future<List<Song>> _fetchSongsPage(int page) {
    return MusicApi.getSingerSongs(widget.artistId, page: page, pagesize: _pageSize);
  }

  Future<void> _loadMore() async {
    if (_isLoadingMore || !_hasMore || !mounted) return;

    setState(() => _isLoadingMore = true);

    final nextPage = _currentPage + 1;
    final moreSongs = await _fetchSongsPage(nextPage);

    if (mounted) {
      setState(() {
        if (moreSongs.isNotEmpty) {
          _songs = [...?_songs, ...moreSongs];
          _currentPage = nextPage;
          _hasMore = _computeHasMore(
            loadedCount: _songs?.length ?? 0,
            lastPageCount: moreSongs.length,
          );
        } else {
          _hasMore = false;
        }
        _isLoadingMore = false;
      });
    }
  }

  Future<void> _preloadRemainingSongsForPlayback(
    AudioProvider audioProvider, {
    required int sessionId,
    required int startPage,
  }) async {
    if (!_hasMore) return;

    var page = startPage;
    var loadedCount = _songs?.length ?? 0;
    while (audioProvider.playlistSessionId == sessionId) {
      final moreSongs = await _fetchSongsPage(page);
      if (moreSongs.isEmpty) return;
      if (!audioProvider.appendSongsToActivePlaylist(moreSongs, sessionId: sessionId)) {
        return;
      }
      loadedCount += moreSongs.length;
      if (!_computeHasMore(loadedCount: loadedCount, lastPageCount: moreSongs.length)) {
        return;
      }
      page++;
    }
  }

  @override
  Widget build(BuildContext context) {
    final userProvider = context.watch<UserProvider>();
    final isFollowing = userProvider.isFollowingSinger(widget.artistId);
    final theme = Theme.of(context);

    return SongListScaffold(
      songs: _songs ?? [],
      isLoading: _isLoading,
      sourceId: widget.artistId,
      onLoadMore: _loadMore,
      hasMore: _hasMore,
      isLoadingMore: _isLoadingMore,
      headers: [
        SliverAppBar(
          backgroundColor: theme.scaffoldBackgroundColor,
          surfaceTintColor: Colors.transparent,
          expandedHeight: 180,
          pinned: true,
          automaticallyImplyLeading: false,
          elevation: 0,
          flexibleSpace: FlexibleSpaceBar(
            titlePadding: EdgeInsets.zero,
            centerTitle: false,
            expandedTitleScale: 1.0,
            title: LayoutBuilder(
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
                        if (_artist != null)
                          CoverImage(
                            url: _artist!.pic,
                            width: 32,
                            height: 32,
                            borderRadius: 16,
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
            ),
            background: Container(
              padding: const EdgeInsets.fromLTRB(24, 0, 24, 0),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.center,
                children: [
                  if (_artist != null)
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
                          imageUrl: _artist!.pic,
                          width: 130,
                          height: 130,
                          fit: BoxFit.cover,
                        ),
                      ),
                    )
                  else
                    Container(
                      width: 130,
                      height: 130,
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
                            fontSize: 22,
                            fontWeight: FontWeight.w900,
                            height: 1.1,
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        const SizedBox(height: 8),
                        if (_artist != null)
                          Row(
                            children: [
                              Text(
                                '${_artist!.songCount} 首歌曲 • ${_artist!.albumCount} 张专辑 • ${_artist!.fansCount} 粉丝',
                                style: TextStyle(
                                  color: theme.colorScheme.onSurfaceVariant,
                                  fontSize: 14,
                                  fontWeight: FontWeight.w700,
                                ),
                              ),
                              const Spacer(),
                              OutlinedButton.icon(
                                onPressed: () async {
                                  bool success;
                                  if (isFollowing) {
                                    success = await userProvider.unfollowSinger(widget.artistId);
                                    if (!context.mounted) return;
                                    if (success) {
                                      CustomToast.success(context, '已取消关注');
                                    } else {
                                      CustomToast.error(context, '操作失败');
                                    }
                                  } else {
                                    success = await userProvider.followSinger(widget.artistId);
                                    if (!context.mounted) return;
                                    if (success) {
                                      CustomToast.success(context, '关注成功');
                                    } else {
                                      CustomToast.error(context, '关注失败');
                                    }
                                  }
                                },
                                icon: Icon(isFollowing ? CupertinoIcons.check_mark : CupertinoIcons.add, size: 16),
                                label: Text(isFollowing ? '已关注' : '关注', style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700)),
                                style: OutlinedButton.styleFrom(
                                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                                  side: BorderSide(color: theme.colorScheme.outlineVariant),
                                  padding: const EdgeInsets.symmetric(horizontal: 16),
                                  minimumSize: const Size(0, 36),
                                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                                ),
                              ),
                              const SizedBox(width: 12),
                              OutlinedButton.icon(
                                onPressed: () {
                                  final songs = _songs ?? [];
                                  if (songs.isNotEmpty) {
                                    final firstPlayableIndex = songs.indexWhere((song) => song.isPlayable);
                                    if (firstPlayableIndex == -1) {
                                      CustomToast.error(context, '当前列表暂无可播放歌曲');
                                      return;
                                    }
                                    final audioProvider = context.read<AudioProvider>();
                                    unawaited(audioProvider.playSong(songs[firstPlayableIndex], playlist: songs));
                                    final sessionId = audioProvider.playlistSessionId;
                                    unawaited(_preloadRemainingSongsForPlayback(
                                      audioProvider,
                                      sessionId: sessionId,
                                      startPage: _currentPage + 1,
                                    ));
                                  }
                                },
                                icon: Icon(CupertinoIcons.play_fill, size: 16, color: theme.colorScheme.primary),
                                label: Text('播放热门', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: theme.colorScheme.primary)),
                                style: OutlinedButton.styleFrom(
                                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                                  side: BorderSide(color: theme.colorScheme.primary.withAlpha(100)),
                                  padding: const EdgeInsets.symmetric(horizontal: 16),
                                  minimumSize: const Size(0, 36),
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
            ),
          ),
        ),
        if (_artist != null && _artist!.intro.isNotEmpty)
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(24, 8, 24, 16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '歌手简介',
                    style: theme.textTheme.titleMedium?.copyWith(
                      fontWeight: FontWeight.w800,
                      fontSize: 15,
                    ),
                  ),
                  const SizedBox(height: 6),
                  Text(
                    _artist!.intro,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                      height: 1.5,
                      fontWeight: FontWeight.w500,
                      fontSize: 12,
                    ),
                  ),
                  if (_artist!.intro.length > 80)
                    InkWell(
                      onTap: () {
                        CustomDialog.show(
                          context,
                          title: '歌手简介',
                          content: _artist!.intro,
                          confirmText: '确定',
                          showCancel: false,
                          width: 600,
                        );
                      },
                      hoverColor: Colors.transparent,
                      splashColor: Colors.transparent,
                      highlightColor: Colors.transparent,
                      child: Padding(
                        padding: const EdgeInsets.symmetric(vertical: 2),
                        child: Text(
                          '查看详情',
                          style: TextStyle(
                            color: theme.colorScheme.primary,
                            fontSize: 11,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
        SliverToBoxAdapter(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(24, 0, 24, 8),
            child: Text(
              '热门歌曲',
              style: theme.textTheme.titleMedium?.copyWith(
                fontWeight: FontWeight.w800,
                fontSize: 15,
              ),
            ),
          ),
        ),
      ],
    );
  }
}
