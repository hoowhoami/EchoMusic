import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import 'package:intl/intl.dart';
import '../../api/music_api.dart';
import '../../models/playlist.dart';
import '../../models/song.dart';
import 'package:echomusic/providers/audio_provider.dart';
import 'package:echomusic/providers/user_provider.dart';
import 'package:echomusic/providers/refresh_provider.dart';
import '../widgets/cover_image.dart';
import '../widgets/custom_toast.dart';
import '../widgets/song_list_scaffold.dart';

class PlaylistDetailRouteArgs {
  const PlaylistDetailRouteArgs({
    required this.playlist,
  });

  final Playlist playlist;

  int get playlistId => playlist.id;

  String get lookupId => playlist.globalCollectionId ?? playlist.id.toString();

  int? get trackListId => playlist.listid;

  String? get trackListCreateGid => playlist.listCreateGid;

  int? get trackListCreateUserid => playlist.listCreateUserid;

  factory PlaylistDetailRouteArgs.fromPlaylist(Playlist playlist) {
    return PlaylistDetailRouteArgs(playlist: playlist);
  }
}

class PlaylistDetailView extends StatefulWidget {
  final PlaylistDetailRouteArgs routeArgs;

  const PlaylistDetailView({
    super.key,
    required this.routeArgs,
  });

  @override
  State<PlaylistDetailView> createState() => _PlaylistDetailViewState();
}

class _PlaylistDetailViewState extends State<PlaylistDetailView> with RefreshableState {
  static const int _pageSize = 200;

  late final PlaylistDetailRouteArgs _routeArgs;

  @override
  String get refreshKey => 'playlist:${_routeArgs.lookupId}';

  List<Song>? _songs;
  Playlist? _detailedPlaylist;
  bool _isLoading = true;
  late UserProvider _userProvider;
  int _currentPage = 1;
  int _loadedSongEntryCount = 0;
  int _filteredInvalidSongCount = 0;
  bool _hasMore = true;
  bool _isLoadingMore = false;

  int get _totalSongCount {
    final detailedCount = _detailedPlaylist?.count ?? 0;
    if (detailedCount > 0) return detailedCount;
    final playlistCount = _routeArgs.playlist.count;
    if (playlistCount > 0) return playlistCount;
    return 0;
  }

  String get _lookupId => _routeArgs.lookupId;

  bool _computeHasMore({required int loadedCount, required int lastPageCount}) {
    final totalSongCount = _totalSongCount;
    if (totalSongCount > 0) return loadedCount < totalSongCount;
    return lastPageCount >= _pageSize;
  }

  @override
  void initState() {
    super.initState();
    _routeArgs = widget.routeArgs;
    _userProvider = context.read<UserProvider>();
    _userProvider.playlistSongsChangeNotifier.addListener(_onPlaylistSongsChanged);
    _loadData();
  }

  @override
  void onRefresh() {
    _loadData();
  }

  @override
  void dispose() {
    _userProvider.playlistSongsChangeNotifier.removeListener(_onPlaylistSongsChanged);
    super.dispose();
  }

  Future<void> _loadData() async {
    if (!mounted) return;
    setState(() {
      _isLoading = true;
      _currentPage = 1;
      _loadedSongEntryCount = 0;
      _filteredInvalidSongCount = 0;
      _hasMore = true;
    });

    // Fetch detailed info to get creator and timestamps
    final detailJson = await MusicApi.getPlaylistDetail(_lookupId);

    if (detailJson != null && mounted) {
      setState(() {
        _detailedPlaylist = Playlist.fromUserPlaylist(detailJson);
      });
    }

    final result = await _fetchSongsPage(1);
    final songs = result.songs;

    if (mounted) {
      setState(() {
        _songs = songs;
        _isLoading = false;
        _loadedSongEntryCount = result.sourceCount;
        _filteredInvalidSongCount = result.filteredCount;
        _hasMore = _computeHasMore(
          loadedCount: _loadedSongEntryCount,
          lastPageCount: result.sourceCount,
        );
      });
    }
  }

  Future<PlaylistSongsParseResult> _fetchSongsPage(int page) {
    return MusicApi.getPlaylistSongsWithMetadata(
      _lookupId,
      listid: _routeArgs.trackListId,
      listCreateGid: _routeArgs.trackListCreateGid,
      listCreateUserid: _routeArgs.trackListCreateUserid,
      page: page,
      pagesize: _pageSize,
    );
  }

  Future<void> _loadMore() async {
    if (_isLoadingMore || !_hasMore || !mounted) return;

    setState(() => _isLoadingMore = true);

    final nextPage = _currentPage + 1;
    final result = await _fetchSongsPage(nextPage);
    final moreSongs = result.songs;
    final pageEntryCount = result.sourceCount;

    if (mounted) {
      setState(() {
        if (pageEntryCount > 0) {
          _songs = [...?_songs, ...moreSongs];
          _currentPage = nextPage;
          _loadedSongEntryCount += pageEntryCount;
          _filteredInvalidSongCount += result.filteredCount;
          _hasMore = _computeHasMore(
            loadedCount: _loadedSongEntryCount,
            lastPageCount: pageEntryCount,
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
    var loadedCount = _loadedSongEntryCount;
    while (audioProvider.playlistSessionId == sessionId) {
      final result = await _fetchSongsPage(page);
      final moreSongs = result.songs;
      final pageEntryCount = result.sourceCount;
      if (pageEntryCount == 0) return;
      if (result.filteredCount > 0) {
        audioProvider.addFilteredInvalidSongsToActivePlaylist(result.filteredCount, sessionId: sessionId);
      }
      if (moreSongs.isNotEmpty &&
          !audioProvider.appendSongsToActivePlaylist(moreSongs, sessionId: sessionId)) {
        return;
      }
      loadedCount += pageEntryCount;
      if (!_computeHasMore(loadedCount: loadedCount, lastPageCount: pageEntryCount)) {
        return;
      }
      page++;
    }
  }

  void _onPlaylistSongsChanged() {
    if (!mounted) return;
    final changedListId = _userProvider.playlistSongsChangeNotifier.value;
    if (changedListId == _routeArgs.playlistId || changedListId == _routeArgs.trackListId) {
      _loadData();
    }
  }

  String _formatTimestamp(int? timestamp) {
    if (timestamp == null || timestamp == 0) return '未知';
    final date = DateTime.fromMillisecondsSinceEpoch(timestamp * 1000);
    return DateFormat('yyyy-MM-dd').format(date);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final userProvider = context.watch<UserProvider>();
    final playlist = _detailedPlaylist ?? _routeArgs.playlist;
    final isFavorited = userProvider.isPlaylistFavorited(playlist.id, globalId: playlist.listCreateGid);
    final isCreated = userProvider.isCreatedPlaylist(playlist.id);

    return SongListScaffold(
      songs: _songs ?? [],
      isLoading: _isLoading,
      parentPlaylist: playlist,
      sourceId: playlist.id,
      onLoadMore: _loadMore,
      hasMore: _hasMore,
      isLoadingMore: _isLoadingMore,
      headers: [
        SliverAppBar(
          backgroundColor: theme.scaffoldBackgroundColor,
          surfaceTintColor: Colors.transparent,
          expandedHeight: 180, 
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
                          url: playlist.pic,
                          width: 32,
                          height: 32,
                          borderRadius: 6,
                          showShadow: false,
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Text(
                            playlist.name,
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
              padding: const EdgeInsets.fromLTRB(24, 0, 24, 0),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.center,
                children: [
                  CoverImage(
                    url: playlist.pic,
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
                          'PLAYLIST',
                          style: TextStyle(
                            color: theme.colorScheme.primary,
                            fontSize: 10,
                            fontWeight: FontWeight.w900,
                            letterSpacing: 2.0,
                          ),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          playlist.name,
                          style: theme.textTheme.titleLarge?.copyWith(
                            fontSize: 22,
                            fontWeight: FontWeight.w900,
                            height: 1.1,
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        const SizedBox(height: 8),
                        if (playlist.nickname.isNotEmpty)
                          Padding(
                            padding: const EdgeInsets.only(bottom: 8.0),
                            child: Row(
                              children: [
                                if (playlist.userPic.isNotEmpty)
                                  Padding(
                                    padding: const EdgeInsets.only(right: 8.0),
                                    child: ClipOval(
                                      child: CoverImage(
                                        url: playlist.userPic,
                                        width: 20,
                                        height: 20,
                                        borderRadius: 0,
                                        showShadow: false,
                                      ),
                                    ),
                                  )
                                else
                                  Padding(
                                    padding: const EdgeInsets.only(right: 8.0),
                                    child: Icon(CupertinoIcons.person_circle_fill, size: 20, color: theme.colorScheme.primary.withAlpha(180)),
                                  ),
                                Text(
                                  playlist.nickname,
                                  style: theme.textTheme.bodyMedium?.copyWith(
                                    color: theme.colorScheme.primary,
                                    fontWeight: FontWeight.w800,
                                    fontSize: 13,
                                  ),
                                ),
                                const SizedBox(width: 12),
                                Text(
                                  '${_formatTimestamp(playlist.createTime)} 创建',
                                  style: TextStyle(
                                    color: theme.colorScheme.onSurface.withAlpha(100),
                                    fontSize: 11,
                                    fontWeight: FontWeight.w600,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        if (playlist.intro.isNotEmpty)
                          Padding(
                            padding: const EdgeInsets.only(bottom: 8.0),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  playlist.intro,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: theme.textTheme.bodyMedium?.copyWith(
                                    color: theme.colorScheme.onSurfaceVariant,
                                    fontWeight: FontWeight.w500,
                                    fontSize: 12,
                                    height: 1.4,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        Row(
                          children: [
                            _buildInfoChip(context, CupertinoIcons.music_note_2, '${playlist.count} 首歌曲'),
                            const Spacer(),
                            if (userProvider.isAuthenticated && !isCreated) ...[
                              OutlinedButton.icon(
                                onPressed: () async {
                                  bool success;
                                  if (isFavorited) {
                                    success = await userProvider.unfavoritePlaylist(playlist.id, globalId: playlist.listCreateGid);
                                    if (context.mounted) {
                                      if (success) {
                                        CustomToast.success(context, '已取消收藏');
                                      } else {
                                        CustomToast.error(context, '操作失败');
                                      }
                                    }
                                  } else {
                                    success = await userProvider.favoritePlaylist(
                                      playlist.originalId, 
                                      playlist.name,
                                      listCreateUserid: playlist.listCreateUserid,
                                      listCreateGid: playlist.listCreateGid,
                                      listCreateListid: playlist.listCreateListid,
                                    );
                                    if (context.mounted) {
                                      if (success) {
                                        CustomToast.success(context, '已收藏歌单');
                                      } else {
                                        CustomToast.error(context, '收藏失败');
                                      }
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
                            ],
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
                                  if (_filteredInvalidSongCount > 0) {
                                    audioProvider.addFilteredInvalidSongsToActivePlaylist(
                                      _filteredInvalidSongCount,
                                      sessionId: sessionId,
                                    );
                                  }
                                  unawaited(_preloadRemainingSongsForPlayback(
                                    audioProvider,
                                    sessionId: sessionId,
                                    startPage: _currentPage + 1,
                                  ));
                                }
                              },
                              icon: Icon(CupertinoIcons.play_fill, size: 16, color: theme.colorScheme.primary),
                              label: Text('播放', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: theme.colorScheme.primary)),
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
      ],
    );
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
