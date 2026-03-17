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
import '../widgets/custom_toast.dart';
import '../widgets/detail_page_action_row.dart';
import '../widgets/detail_page_sliver_header.dart';
import '../widgets/song_list_scaffold.dart';
import 'package:echomusic/theme/app_theme.dart';

class HistoryView extends StatefulWidget {
  const HistoryView({super.key, this.fetchHistoryPage});

  final Future<Map<String, dynamic>> Function(String? bp)? fetchHistoryPage;

  @override
  State<HistoryView> createState() => _HistoryViewState();
}

class _HistoryViewState extends State<HistoryView>
    with RefreshableState<HistoryView> {
  static const int _rootIndex = 3;

  bool _loaded = false;
  bool _wasAuthenticated = false;
  bool _isLoadScheduled = false;
  bool _isResetScheduled = false;
  List<Song> _songs = const <Song>[];
  bool _isLoading = false;
  bool _hasMore = true;
  bool _isLoadingMore = false;
  bool _isResolvingAllSongs = false;
  bool _hasScheduledWarmUp = false;
  String? _nextBp;
  List<Song>? _allSongsCache;
  Future<List<Song>>? _resolveAllSongsFuture;
  AudioProvider? _playbackAppendProvider;
  int? _playbackAppendSessionId;

  @override
  String get refreshKey => 'root:3';

  @override
  void onRefresh() {
    final userProvider = context.read<UserProvider>();
    if (userProvider.isAuthenticated) {
      _loaded = true;
      _wasAuthenticated = true;
      unawaited(_loadData());
    }
  }

  Future<Map<String, dynamic>> _fetchHistoryPage(String? bp) {
    final fetchHistoryPage = widget.fetchHistoryPage;
    if (fetchHistoryPage != null) {
      return fetchHistoryPage(bp);
    }
    return MusicApi.getUserPlayHistory(bp: bp);
  }

  void _resetState() {
    _isLoadScheduled = false;
    _songs = const <Song>[];
    _isLoading = false;
    _hasMore = true;
    _isLoadingMore = false;
    _isResolvingAllSongs = false;
    _hasScheduledWarmUp = false;
    _nextBp = null;
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

  Future<void> _loadData() async {
    if (!mounted) return;

    setState(() {
      _songs = const <Song>[];
      _isLoading = true;
      _hasMore = true;
      _isLoadingMore = false;
      _isResolvingAllSongs = false;
      _hasScheduledWarmUp = false;
      _nextBp = null;
      _allSongsCache = null;
      _resolveAllSongsFuture = null;
      _playbackAppendProvider = null;
      _playbackAppendSessionId = null;
    });

    try {
      final result = await _fetchHistoryPage(null);
      final songs = List<Song>.from(
        result['songs'] as List<Song>? ?? const <Song>[],
      );
      final nextBp = result['bp']?.toString();
      final hasMore = result['has_more'] == true && nextBp != null;

      if (!mounted) return;

      setState(() {
        _songs = songs;
        _isLoading = false;
        _nextBp = nextBp;
        _hasMore = hasMore;
        if (!hasMore) {
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

  Future<List<Song>> _ensureAllSongsLoaded() async {
    if (_allSongsCache != null) return _allSongsCache!;

    final existingFuture = _resolveAllSongsFuture;
    if (existingFuture != null) return existingFuture;

    if (_isLoading) return List<Song>.from(_songs);

    if (!_hasMore || _nextBp == null) {
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
    var nextBp = _nextBp;
    var hasMore = _hasMore;

    try {
      while (hasMore && nextBp != null) {
        final result = await _fetchHistoryPage(nextBp);
        final moreSongs = List<Song>.from(
          result['songs'] as List<Song>? ?? const <Song>[],
        );
        nextBp = result['bp']?.toString();
        hasMore = result['has_more'] == true && nextBp != null;

        if (moreSongs.isEmpty) {
          hasMore = false;
          break;
        }

        songs.addAll(moreSongs);

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
            _nextBp = nextBp;
            _hasMore = hasMore;
          });
        }
      }

      final resolvedSongs = List<Song>.unmodifiable(songs);
      _allSongsCache = resolvedSongs;
      _resolveAllSongsFuture = Future<List<Song>>.value(resolvedSongs);

      if (mounted) {
        setState(() {
          _songs = List<Song>.from(songs);
          _nextBp = nextBp;
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

  void _playHistorySongs(List<Song> songs) {
    if (songs.isEmpty) return;
    final firstPlayableIndex = songs.indexWhere((song) => song.isPlayable);
    if (firstPlayableIndex == -1) {
      CustomToast.error(context, '当前暂无可播放的历史歌曲');
      return;
    }
    unawaited(
      _replacePlaybackWithHistorySongs(songs[firstPlayableIndex], songs),
    );
  }

  Future<void> _replacePlaybackWithHistorySongs(
    Song song,
    List<Song> songs,
  ) async {
    if (songs.isEmpty) return;
    if (!songs.any((entry) => entry.isPlayable)) {
      CustomToast.error(context, '当前暂无可播放的历史歌曲');
      return;
    }

    final audioProvider = context.read<AudioProvider>();
    unawaited(audioProvider.playSong(song, playlist: songs));
    final sessionId = audioProvider.playlistSessionId;
    _attachPlaybackPrefetch(audioProvider, sessionId);
    if (context.read<UserProvider>().isAuthenticated) {
      unawaited(_ensureAllSongsLoaded());
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isAuthenticated = context.select<UserProvider, bool>(
      (provider) => provider.isAuthenticated,
    );
    final isCurrentRoot = context.select<NavigationProvider, bool>(
      (provider) => provider.isCurrentRoot(_rootIndex),
    );
    final persistenceProvider = context.watch<PersistenceProvider>();
    final replacePlaylistEnabled = context.select<PersistenceProvider, bool>(
      (provider) => provider.settings['replacePlaylist'] ?? false,
    );

    if (!isAuthenticated) {
      _scheduleResetState();
    } else if (!isCurrentRoot) {
      _loaded = false;
    } else if (isCurrentRoot &&
        (!_loaded || !_wasAuthenticated) &&
        !_isLoading) {
      _scheduleInitialLoad();
    }

    final songs = isAuthenticated ? _songs : persistenceProvider.history;
    final batchPreparing = isAuthenticated && _isResolvingAllSongs && _hasMore;

    return SongListScaffold(
      songs: songs,
      isLoading: isAuthenticated ? _isLoading : false,
      onLoadMore: isAuthenticated ? _loadMore : null,
      hasMore: isAuthenticated ? _hasMore : false,
      isLoadingMore: isAuthenticated
          ? (_isLoadingMore || batchPreparing)
          : false,
      hasCommentsTab: false,
      enableDefaultDoubleTapPlay: true,
      onSongDoubleTapPlay: replacePlaylistEnabled
          ? (song) => _replacePlaybackWithHistorySongs(song, songs)
          : null,
      headers: [
        DetailPageSliverHeader(
          typeLabel: 'HISTORY',
          title: '最近播放',
          expandedHeight: 200,
          expandedCover: _buildExpandedHistoryCover(theme),
          collapsedCover: _buildCollapsedHistoryCover(theme),
          detailChildren: [
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                '历史记录仅供参考',
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
                  '${songs.length}',
                ),
              ],
            ),
            if (!isAuthenticated)
              Text(
                '当前展示本地播放历史',
                style: TextStyle(
                  color: theme.colorScheme.onSurfaceVariant.withAlpha(180),
                  fontSize: 12,
                  fontWeight: AppTheme.fontWeightMedium,
                ),
              ),
          ],
          actions: DetailPageActionRow(
            playLabel: '播放',
            onPlay: () => _playHistorySongs(songs),
            songs: songs,
            onResolveSongs: isAuthenticated ? _ensureAllSongsLoaded : null,
            isBatchPreparing: batchPreparing,
          ),
        ),
      ],
    );
  }

  Widget _buildExpandedHistoryCover(ThemeData theme) {
    return Container(
      width: 136,
      height: 136,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(24),
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [
            theme.colorScheme.secondary.withAlpha(220),
            theme.colorScheme.primary.withAlpha(180),
          ],
        ),
        boxShadow: [
          BoxShadow(
            color: theme.colorScheme.secondary.withAlpha(36),
            blurRadius: 24,
            offset: const Offset(0, 12),
          ),
        ],
      ),
      child: Icon(
        CupertinoIcons.time_solid,
        size: 56,
        color: theme.colorScheme.onSecondary,
      ),
    );
  }

  Widget _buildCollapsedHistoryCover(ThemeData theme) {
    return Container(
      width: 32,
      height: 32,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(8),
        color: theme.colorScheme.secondary.withAlpha(32),
      ),
      child: Icon(
        CupertinoIcons.time_solid,
        size: 16,
        color: theme.colorScheme.secondary,
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
