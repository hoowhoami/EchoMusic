import 'dart:async';

import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../api/music_api.dart';
import '../../models/song.dart';
import '../../providers/audio_provider.dart';
import '../../providers/navigation_provider.dart';
import '../../providers/persistence_provider.dart';
import '../../providers/refresh_provider.dart';
import '../../providers/user_provider.dart';
import '../../utils/format_utils.dart';
import '../widgets/custom_toast.dart';
import '../widgets/detail_page_action_row.dart';
import '../widgets/detail_page_sliver_header.dart';
import '../widgets/song_list_scaffold.dart';
import 'package:echomusic/theme/app_theme.dart';

class CloudView extends StatefulWidget {
  const CloudView({super.key, this.fetchSongsPage});

  final Future<Map<String, dynamic>> Function(int page, int pageSize)?
  fetchSongsPage;

  @override
  State<CloudView> createState() => _CloudViewState();
}

class _CloudViewState extends State<CloudView>
    with RefreshableState<CloudView> {
  static const int _rootIndex = 4;
  static const int _pageSize = 100;

  bool _loaded = false;
  bool _wasAuthenticated = false;
  bool _isLoadScheduled = false;
  bool _isResetScheduled = false;
  List<Song> _songs = const <Song>[];
  bool _isLoading = true;
  int _currentPage = 1;
  int _totalSongCount = 0;
  int _cloudCapacity = 0;
  int _cloudAvailable = 0;
  bool _hasMore = true;
  bool _isLoadingMore = false;
  bool _isResolvingAllSongs = false;
  bool _hasScheduledWarmUp = false;
  List<Song>? _allSongsCache;
  Future<List<Song>>? _resolveAllSongsFuture;
  AudioProvider? _playbackAppendProvider;
  int? _playbackAppendSessionId;

  @override
  String get refreshKey => 'root:4';

  bool _computeHasMore({
    required int loadedCount,
    required int lastPageCount,
    int? totalCount,
  }) {
    final expectedCount = totalCount ?? _totalSongCount;
    if (expectedCount > 0) return loadedCount < expectedCount;
    return lastPageCount >= _pageSize;
  }

  int _asInt(dynamic value) {
    if (value is int) return value;
    return int.tryParse(value?.toString() ?? '') ?? 0;
  }

  @override
  void initState() {
    super.initState();
    _isLoading = false;
  }

  @override
  void onRefresh() {
    final userProvider = context.read<UserProvider>();
    if (userProvider.isAuthenticated) {
      _loaded = true;
      _wasAuthenticated = true;
      unawaited(_loadData());
    }
  }

  void _resetState() {
    _isLoadScheduled = false;
    _songs = const <Song>[];
    _isLoading = false;
    _currentPage = 1;
    _totalSongCount = 0;
    _cloudCapacity = 0;
    _cloudAvailable = 0;
    _hasMore = true;
    _isLoadingMore = false;
    _isResolvingAllSongs = false;
    _hasScheduledWarmUp = false;
    _allSongsCache = null;
    _resolveAllSongsFuture = null;
    _playbackAppendProvider = null;
    _playbackAppendSessionId = null;
  }

  void _scheduleInitialLoad() {
    if (_isLoadScheduled || !mounted) return;
    _isLoadScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _isLoadScheduled = false;
      if (!mounted) return;
      final currentRootIndex = context
          .read<NavigationProvider>()
          .currentRootIndex;
      final isAuthenticated = context.read<UserProvider>().isAuthenticated;
      if (currentRootIndex != _rootIndex ||
          !isAuthenticated ||
          _isLoading ||
          (_loaded && _wasAuthenticated)) {
        return;
      }
      _loaded = true;
      _wasAuthenticated = true;
      unawaited(_loadData());
    });
  }

  void _scheduleResetState() {
    if (_isResetScheduled || !mounted) return;
    _isResetScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _isResetScheduled = false;
      if (!mounted) return;
      if (context.read<UserProvider>().isAuthenticated) return;
      if (!_loaded && !_wasAuthenticated && _songs.isEmpty && !_isLoading) {
        return;
      }
      setState(() {
        _wasAuthenticated = false;
        _loaded = false;
        _resetState();
      });
    });
  }

  Future<Map<String, dynamic>> _fetchSongsPage(int page) {
    final fetchSongsPage = widget.fetchSongsPage;
    if (fetchSongsPage != null) {
      return fetchSongsPage(page, _pageSize);
    }
    return MusicApi.getUserCloud(page: page, pagesize: _pageSize);
  }

  Future<void> _loadData() async {
    if (!mounted) return;

    setState(() {
      _isLoading = true;
      _songs = const <Song>[];
      _currentPage = 1;
      _totalSongCount = 0;
      _cloudCapacity = 0;
      _cloudAvailable = 0;
      _hasMore = true;
      _isLoadingMore = false;
      _isResolvingAllSongs = false;
      _hasScheduledWarmUp = false;
      _allSongsCache = null;
      _resolveAllSongsFuture = null;
      _playbackAppendProvider = null;
      _playbackAppendSessionId = null;
    });

    try {
      final result = await _fetchSongsPage(1);
      final songs = List<Song>.from(
        result['songs'] as List<Song>? ?? const <Song>[],
      );
      final totalCount = _asInt(result['count']);
      final capacity = _asInt(result['capacity']);
      final available = _asInt(result['available']);

      if (!mounted) return;

      setState(() {
        _songs = songs;
        _isLoading = false;
        _currentPage = 1;
        _totalSongCount = totalCount;
        _cloudCapacity = capacity;
        _cloudAvailable = available;
        _hasMore = _computeHasMore(
          loadedCount: songs.length,
          lastPageCount: songs.length,
          totalCount: totalCount,
        );
        if (!_hasMore) {
          _allSongsCache = List<Song>.unmodifiable(songs);
        }
      });

      _scheduleBackgroundResolve();
    } catch (_) {
      _loaded = false;
      if (!mounted) return;
      setState(() {
        _isLoading = false;
        _hasMore = false;
      });
    }
  }

  void _scheduleBackgroundResolve() {
    if (_hasScheduledWarmUp || !_hasMore || !mounted) return;
    _hasScheduledWarmUp = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_hasMore) return;
      unawaited(_ensureAllSongsLoaded());
    });
  }

  Future<void> _loadMore() async {
    if (_isLoadingMore || !_hasMore || !mounted) return;

    setState(() => _isLoadingMore = true);
    try {
      await _ensureAllSongsLoaded();
    } finally {
      if (mounted) {
        setState(() => _isLoadingMore = false);
      }
    }
  }

  Future<List<Song>> _loadAllSongsForBatch() => _ensureAllSongsLoaded();

  Future<List<Song>> _ensureAllSongsLoaded() async {
    if (_allSongsCache != null) {
      return _allSongsCache!;
    }

    final existingFuture = _resolveAllSongsFuture;
    if (existingFuture != null) {
      return existingFuture;
    }

    if (_isLoading) return List<Song>.from(_songs);

    if (!_hasMore) {
      final songs = List<Song>.unmodifiable(_songs);
      _allSongsCache = songs;
      return songs;
    }

    if (mounted) {
      setState(() => _isResolvingAllSongs = true);
    } else {
      _isResolvingAllSongs = true;
    }

    final future = _resolveAllSongsInternal();
    _resolveAllSongsFuture = future;
    try {
      return await future;
    } finally {
      if (mounted) {
        setState(() => _isResolvingAllSongs = false);
      } else {
        _isResolvingAllSongs = false;
      }
    }
  }

  Future<List<Song>> _resolveAllSongsInternal() async {
    final songs = [..._songs];
    var nextPage = _currentPage + 1;
    var lastLoadedPage = _currentPage;
    var hasMore = _hasMore;
    var totalCount = _totalSongCount;
    var capacity = _cloudCapacity;
    var available = _cloudAvailable;

    try {
      while (hasMore) {
        final result = await _fetchSongsPage(nextPage);
        final moreSongs = List<Song>.from(
          result['songs'] as List<Song>? ?? const <Song>[],
        );
        totalCount = _asInt(result['count']);
        capacity = _asInt(result['capacity']);
        available = _asInt(result['available']);

        if (moreSongs.isEmpty) {
          hasMore = false;
          break;
        }

        songs.addAll(moreSongs);
        lastLoadedPage = nextPage;
        hasMore = _computeHasMore(
          loadedCount: songs.length,
          lastPageCount: moreSongs.length,
          totalCount: totalCount,
        );

        final playbackProvider = _playbackAppendProvider;
        final playbackSessionId = _playbackAppendSessionId;
        if (playbackProvider != null && playbackSessionId != null) {
          if (playbackProvider.playlistSessionId == playbackSessionId) {
            if (!playbackProvider.appendSongsToActivePlaylist(
              moreSongs,
              sessionId: playbackSessionId,
            )) {
              _playbackAppendProvider = null;
              _playbackAppendSessionId = null;
            }
          } else {
            _playbackAppendProvider = null;
            _playbackAppendSessionId = null;
          }
        }

        if (mounted) {
          setState(() {
            _songs = List<Song>.from(songs);
            _currentPage = lastLoadedPage;
            _totalSongCount = totalCount;
            _cloudCapacity = capacity;
            _cloudAvailable = available;
            _hasMore = hasMore;
          });
        }
        nextPage++;
      }

      final resolvedSongs = List<Song>.unmodifiable(songs);
      _allSongsCache = resolvedSongs;
      _resolveAllSongsFuture = Future<List<Song>>.value(resolvedSongs);

      if (mounted) {
        setState(() {
          _songs = List<Song>.from(songs);
          _currentPage = lastLoadedPage;
          _totalSongCount = totalCount;
          _cloudCapacity = capacity;
          _cloudAvailable = available;
          _hasMore = hasMore;
        });
      }

      return resolvedSongs;
    } catch (_) {
      _resolveAllSongsFuture = null;
      rethrow;
    }
  }

  void _attachPlaybackPrefetch(AudioProvider audioProvider, int sessionId) {
    _playbackAppendProvider = audioProvider;
    _playbackAppendSessionId = sessionId;
  }

  void _playCloudSongs() {
    if (_songs.isEmpty) return;
    final firstPlayableIndex = _songs.indexWhere((song) => song.isPlayable);
    if (firstPlayableIndex == -1) {
      CustomToast.error(context, '当前云盘暂无可播放歌曲');
      return;
    }
    unawaited(_replacePlaybackWithCloudSongs(_songs[firstPlayableIndex]));
  }

  Future<void> _replacePlaybackWithCloudSongs(Song song) async {
    if (_songs.isEmpty) return;
    if (!_songs.any((entry) => entry.isPlayable)) {
      CustomToast.error(context, '当前云盘暂无可播放歌曲');
      return;
    }

    final audioProvider = context.read<AudioProvider>();
    unawaited(audioProvider.playSong(song, playlist: _songs));
    final sessionId = audioProvider.playlistSessionId;
    _attachPlaybackPrefetch(audioProvider, sessionId);
    unawaited(_ensureAllSongsLoaded());
  }

  int get _displaySongCount =>
      _totalSongCount > 0 ? _totalSongCount : _songs.length;

  @override
  Widget build(BuildContext context) {
    final isAuthenticated = context.select<UserProvider, bool>(
      (provider) => provider.isAuthenticated,
    );
    final isCurrentRoot = context.select<NavigationProvider, bool>(
      (provider) => provider.isCurrentRoot(_rootIndex),
    );
    final theme = Theme.of(context);

    if (!isAuthenticated) {
      _scheduleResetState();
      return Center(
        child: Text(
          '登录后查看云盘',
          style: TextStyle(
            fontWeight: AppTheme.fontWeightSemiBold,
            color: theme.colorScheme.onSurface.withAlpha(128),
          ),
        ),
      );
    }

    if (!isCurrentRoot) {
      _loaded = false;
    }

    if (isCurrentRoot && (!_loaded || !_wasAuthenticated) && !_isLoading) {
      _scheduleInitialLoad();
    }

    final replacePlaylistEnabled = context.select<PersistenceProvider, bool>(
      (provider) => provider.settings['replacePlaylist'] ?? false,
    );
    final songs = _songs;
    final used = (_cloudCapacity - _cloudAvailable).clamp(0, _cloudCapacity);
    final percentage = _cloudCapacity > 0 ? (used / _cloudCapacity) : 0.0;
    final batchPreparing = _isResolvingAllSongs && _hasMore;

    return SongListScaffold(
      songs: songs,
      isLoading: _isLoading,
      onLoadMore: _loadMore,
      hasMore: _hasMore,
      isLoadingMore: _isLoadingMore || batchPreparing,
      hasCommentsTab: false,
      enableDefaultDoubleTapPlay: true,
      onSongDoubleTapPlay: replacePlaylistEnabled
          ? _replacePlaybackWithCloudSongs
          : null,
      headers: [
        DetailPageSliverHeader(
          typeLabel: 'CLOUD',
          title: '音乐云盘',
          expandedHeight: 200,
          expandedCover: _buildExpandedCloudCover(theme),
          collapsedCover: _buildCollapsedCloudCover(theme),
          detailChildren: [
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                '仅支持基础的云盘功能',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: theme.colorScheme.onSurfaceVariant.withAlpha(180),
                  fontSize: 12,
                  fontWeight: AppTheme.fontWeightMedium,
                ),
              ),
            ),
            Wrap(
              spacing: 10,
              runSpacing: 8,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: [
                _buildInfoSmall(
                  context,
                  CupertinoIcons.music_note_2,
                  '$_displaySongCount',
                ),
              ],
            ),
          ],
          actions: DetailPageActionRow(
            playLabel: '播放',
            onPlay: _playCloudSongs,
            songs: songs,
            onResolveSongs: _loadAllSongsForBatch,
            isBatchPreparing: batchPreparing,
          ),
        ),
        SliverToBoxAdapter(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(24, 10, 24, 6),
            child: _buildCloudInfoCard(theme, used, percentage),
          ),
        ),
      ],
    );
  }

  Widget _buildExpandedCloudCover(ThemeData theme) {
    return Container(
      width: 136,
      height: 136,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(24),
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [
            theme.colorScheme.primary.withAlpha(220),
            theme.colorScheme.tertiary.withAlpha(180),
          ],
        ),
        boxShadow: [
          BoxShadow(
            color: theme.colorScheme.primary.withAlpha(36),
            blurRadius: 24,
            offset: const Offset(0, 12),
          ),
        ],
      ),
      child: Icon(
        CupertinoIcons.cloud_fill,
        size: 56,
        color: theme.colorScheme.onPrimary,
      ),
    );
  }

  Widget _buildCollapsedCloudCover(ThemeData theme) {
    return Container(
      width: 32,
      height: 32,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(8),
        color: theme.colorScheme.primary.withAlpha(32),
      ),
      child: Icon(
        CupertinoIcons.cloud_fill,
        size: 16,
        color: theme.colorScheme.primary,
      ),
    );
  }

  Widget _buildCloudInfoCard(ThemeData theme, int used, double percentage) {
    final total = _cloudCapacity;

    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: theme.colorScheme.surfaceContainerHighest.withAlpha(100),
        borderRadius: BorderRadius.circular(14),
        border: Border.all(
          color: theme.colorScheme.outlineVariant.withAlpha(80),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                '云盘容量',
                style: TextStyle(
                  fontSize: 13,
                  fontWeight: AppTheme.fontWeightBold,
                  color: theme.colorScheme.onSurface,
                ),
              ),
              Text(
                '${(percentage * 100).toStringAsFixed(1)}%',
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: AppTheme.fontWeightSemiBold,
                  color: theme.colorScheme.primary,
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          ClipRRect(
            borderRadius: BorderRadius.circular(4),
            child: LinearProgressIndicator(
              value: percentage,
              minHeight: 8,
              backgroundColor: theme.colorScheme.surfaceContainerHighest,
              valueColor: AlwaysStoppedAnimation<Color>(
                percentage > 0.9
                    ? theme.colorScheme.error
                    : theme.colorScheme.primary,
              ),
            ),
          ),
          const SizedBox(height: 10),
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                '${formatBytes(used)} / ${formatBytes(total)}',
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: AppTheme.fontWeightMedium,
                  color: theme.colorScheme.onSurface.withAlpha(160),
                ),
              ),
              Text(
                '可用 ${formatBytes(_cloudAvailable)}',
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: AppTheme.fontWeightMedium,
                  color: theme.colorScheme.onSurface.withAlpha(128),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildInfoSmall(BuildContext context, IconData icon, String label) {
    final theme = Theme.of(context);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(
          icon,
          size: 12,
          color: theme.colorScheme.onSurfaceVariant.withAlpha(180),
        ),
        const SizedBox(width: 4),
        Text(
          label,
          style: TextStyle(
            fontSize: 11,
            fontWeight: AppTheme.fontWeightSemiBold,
            color: theme.colorScheme.onSurfaceVariant.withAlpha(180),
          ),
        ),
      ],
    );
  }
}
