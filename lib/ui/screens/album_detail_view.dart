import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import '../../api/music_api.dart';
import '../../models/album.dart';
import '../../models/song.dart';
import '../../providers/audio_provider.dart';
import '../../providers/user_provider.dart';
import '../../providers/refresh_provider.dart';
import '../widgets/cover_image.dart';
import '../widgets/custom_dialog.dart';
import '../widgets/custom_toast.dart';
import '../widgets/song_list_scaffold.dart';
import '../../models/playlist.dart' as model;

class AlbumDetailView extends StatefulWidget {
  final int albumId;
  final String albumName;
  const AlbumDetailView({super.key, required this.albumId, required this.albumName});

  @override
  State<AlbumDetailView> createState() => _AlbumDetailViewState();
}

class _AlbumDetailViewState extends State<AlbumDetailView> with RefreshableState {
  static const int _pageSize = 200;

  Album? _album;
  List<Song>? _songs;
  bool _isLoading = true;
  int _currentPage = 1;
  bool _hasMore = true;
  bool _isLoadingMore = false;

  int get _totalSongCount => _album?.songCount ?? 0;

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
      MusicApi.getAlbumDetail(widget.albumId),
      _fetchSongsPage(1),
    ]);

    if (mounted) {
      setState(() {
        final albumJson = results[0] as Map<String, dynamic>?;
        if (albumJson != null) {
          _album = Album.fromDetailJson(albumJson);
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
    return MusicApi.getAlbumSongs(widget.albumId, page: page, pagesize: _pageSize);
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
    final theme = Theme.of(context);
    final isFavorited = userProvider.isPlaylistFavorited(widget.albumId);

    return SongListScaffold(
      songs: _songs ?? [],
      isLoading: _isLoading,
      sourceId: widget.albumId,
      onLoadMore: _loadMore,
      hasMore: _hasMore,
      isLoadingMore: _isLoadingMore,
      parentPlaylist: _album != null ? model.Playlist(
        id: _album!.id,
        listCreateListid: _album!.id,
        name: _album!.name,
        pic: _album!.pic,
        intro: _album!.intro,
        playCount: _album!.playCount,
        source: 2,
      ) : null,
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
                        if (_album != null)
                          CoverImage(
                            url: _album!.pic,
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
            ),
            background: Container(
              padding: const EdgeInsets.fromLTRB(24, 0, 24, 0),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.center,
                children: [
                  CoverImage(
                    url: _album?.pic ?? '',
                    width: 130,
                    height: 130,
                    borderRadius: 16,
                  ),
                  const SizedBox(width: 24),
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
                            fontSize: 22,
                            fontWeight: FontWeight.w900,
                            height: 1.1,
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        const SizedBox(height: 8),
                        if (_album != null)
                          Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                '${_album!.singerName} • ${_album!.publishTime}',
                                style: TextStyle(
                                  color: theme.colorScheme.onSurfaceVariant, 
                                  fontSize: 14,
                                  fontWeight: FontWeight.w700,
                                ),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                              const SizedBox(height: 12),
                              Row(
                                children: [
                                  _buildInfoSmall(context, Icons.favorite_rounded, _formatNumber(_album!.heat)),
                                  if (_album!.language.isNotEmpty || _album!.type.isNotEmpty) ...[
                                    const SizedBox(width: 12),
                                    if (_album!.language.isNotEmpty) ...[
                                      _buildTag(context, _album!.language),
                                      const SizedBox(width: 8),
                                    ],
                                    if (_album!.type.isNotEmpty) ...[
                                      _buildTag(context, _album!.type),
                                      const SizedBox(width: 8),
                                    ],
                                  ],
                                  const Spacer(),
                                  OutlinedButton.icon(
                                    onPressed: () async {
                                      if (!userProvider.isAuthenticated) {
                                        CustomToast.error(context, '请先登录');
                                        return;
                                      }
                                      
                                      if (_album == null) return;

                                      bool success;
                                      if (isFavorited) {
                                        success = await userProvider.unfavoriteAlbum(widget.albumId);
                                        if (context.mounted && success) {
                                          CustomToast.success(context, '已取消收藏');
                                        }
                                      } else {
                                        success = await userProvider.favoriteAlbum(
                                          widget.albumId, 
                                          widget.albumName,
                                          singerId: _album!.singerId,
                                        );
                                        if (context.mounted && success) {
                                          CustomToast.success(context, '已收藏专辑');
                                        }
                                      }
                                    },
                                    icon: Icon(
                                      isFavorited ? CupertinoIcons.heart_fill : CupertinoIcons.heart, 
                                      size: 16,
                                      color: isFavorited ? Colors.red : null,
                                    ),
                                    label: Text(
                                      '收藏', 
                                      style: TextStyle(
                                        fontSize: 13, 
                                        fontWeight: FontWeight.w700,
                                        color: isFavorited ? Colors.red : null,
                                      )
                                    ),
                                    style: OutlinedButton.styleFrom(
                                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                                      side: BorderSide(
                                        color: isFavorited ? Colors.red.withAlpha(100) : theme.colorScheme.outlineVariant,
                                      ),
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
                                          CustomToast.error(context, '当前专辑暂无可播放歌曲');
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
                                    label: Text('播放专辑', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: theme.colorScheme.primary)),
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
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
        SliverToBoxAdapter(
          child: _album?.intro != null && _album!.intro.isNotEmpty ? Padding(
            padding: const EdgeInsets.fromLTRB(24, 8, 24, 16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '专辑介绍',
                  style: theme.textTheme.titleMedium?.copyWith(
                    fontWeight: FontWeight.w800,
                    fontSize: 15,
                  ),
                ),
                const SizedBox(height: 6),
                Text(
                  _album!.intro,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: theme.textTheme.bodyMedium?.copyWith(
                    color: theme.colorScheme.onSurfaceVariant,
                    height: 1.5,
                    fontWeight: FontWeight.w500,
                    fontSize: 12,
                  ),
                ),
                if (_album!.intro.length > 80)
                  InkWell(
                    onTap: () {
                      CustomDialog.show(
                        context,
                        title: '专辑介绍',
                        content: _album!.intro,
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
          ) : const SizedBox.shrink(),
        ),
      ],
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
