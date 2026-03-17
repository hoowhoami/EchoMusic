import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import '../../api/music_api.dart';
import '../../models/song.dart';
import 'package:provider/provider.dart';
import '../widgets/song_list_scaffold.dart';
import '../widgets/custom_picker.dart';
import '../widgets/custom_selector.dart';
import '../widgets/detail_page_sliver_header.dart';
import '../widgets/detail_page_action_row.dart';
import '../widgets/custom_toast.dart';
import '../../providers/audio_provider.dart';
import '../../providers/persistence_provider.dart';
import 'package:echomusic/theme/app_theme.dart';

class RankView extends StatefulWidget {
  final int? initialRankId;
  final Color? backgroundColor;
  final bool isRecommend;
  final bool showTitle;
  final double? backToTopRight;
  const RankView({
    super.key, 
    this.initialRankId, 
    this.backgroundColor,
    this.isRecommend = false,
    this.showTitle = true,
    this.backToTopRight,
  });

  @override
  State<RankView> createState() => _RankViewState();
}

class _RankViewState extends State<RankView> {
  static const double _compactHeaderHeight = 52.0;

  List<Map<String, dynamic>> _ranks = [];
  List<Song> _rankSongs = [];
  int? _selectedRankId;
  bool _isLoadingRanks = true;
  bool _isLoadingSongs = false;

  @override
  void initState() {
    super.initState();
    _loadRanks();
  }

  @override
  void dispose() {
    super.dispose();
  }

  void _playRankSongs(List<Song> songs) {
    if (songs.isEmpty) return;
    final firstPlayableIndex = songs.indexWhere((song) => song.isPlayable);
    if (firstPlayableIndex == -1) {
      CustomToast.error(context, '当前榜单暂无可播放歌曲');
      return;
    }
    unawaited(_replacePlaybackWithRankSongs(songs[firstPlayableIndex], songs));
  }

  Future<void> _replacePlaybackWithRankSongs(
    Song song,
    List<Song> songs,
  ) async {
    if (songs.isEmpty) return;
    if (!songs.any((entry) => entry.isPlayable)) {
      CustomToast.error(context, '当前榜单暂无可播放歌曲');
      return;
    }

    final audioProvider = context.read<AudioProvider>();
    unawaited(audioProvider.playSong(song, playlist: songs));
  }

  Widget _buildExpandedCover(ThemeData theme) {
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
      ),
      child: Icon(
        CupertinoIcons.chart_bar_circle,
        size: 56,
        color: theme.colorScheme.onSecondary,
      ),
    );
  }

  Widget _buildCollapsedCover(ThemeData theme) {
    return Container(
      width: 32,
      height: 32,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(8),
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [
            theme.colorScheme.secondary.withAlpha(200),
            theme.colorScheme.primary.withAlpha(160),
          ],
        ),
      ),
      child: Icon(
        CupertinoIcons.chart_bar,
        size: 16,
        color: theme.colorScheme.onSecondary,
      ),
    );
  }

  Future<void> _loadRanks() async {
    final ranks = widget.isRecommend 
        ? await MusicApi.getRankTop()
        : await MusicApi.getRanks();
    
    if (ranks.isNotEmpty && mounted) {
      setState(() {
        _ranks = ranks;
        _isLoadingRanks = false;
        _selectedRankId = widget.initialRankId ?? _ranks.first['rankid'];
        _loadRankSongs(_selectedRankId!);
      });
    } else if (mounted) {
      setState(() {
        _isLoadingRanks = false;
      });
    }
  }

  Future<void> _loadRankSongs(int rankId) async {
    setState(() {
      _isLoadingSongs = true;
      _selectedRankId = rankId;
      _rankSongs = [];
    });
    try {
      final songs = await MusicApi.getRankSongs(rankId);
      if (mounted) {
        setState(() {
          _rankSongs = songs;
          _isLoadingSongs = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _isLoadingSongs = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_isLoadingRanks) {
      return const Scaffold(
        body: Center(child: CupertinoActivityIndicator()),
      );
    }

    final selectedRank = _ranks.firstWhere((r) => r['rankid'] == _selectedRankId, orElse: () => _ranks.first);
    final selector = _ranks.isNotEmpty 
        ? CustomSelector(
            label: selectedRank['rankname'],
            onTap: () => _showRankPicker(context),
          )
        : null;
    final listPadding = EdgeInsets.symmetric(
      horizontal: widget.showTitle ? 24 : 40,
      vertical: 8,
    );

    final theme = Theme.of(context);
    final replacePlaylistEnabled =
        context.select<PersistenceProvider, bool>(
      (provider) => provider.settings['replacePlaylist'] ?? false,
    );

    if (widget.showTitle) {
      return SongListScaffold(
        songs: _rankSongs,
        isLoading: _isLoadingSongs,
        backgroundColor: widget.backgroundColor,
        padding: listPadding,
        rowHorizontalPadding: 6,
        hasCommentsTab: false,
        enableDefaultDoubleTapPlay: true,
        onSongDoubleTapPlay: replacePlaylistEnabled
            ? (song) async {
                await _replacePlaybackWithRankSongs(song, _rankSongs);
              }
            : null,
        headers: [
          DetailPageSliverHeader(
            typeLabel: 'RANK',
            title: '排行榜',
            expandedHeight: 200,
            expandedCover: _buildExpandedCover(theme),
            collapsedCover: _buildCollapsedCover(theme),
            detailChildren: [
              Text(
                '实时热门趋势榜单',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: theme.colorScheme.onSurfaceVariant.withAlpha(180),
                  fontSize: 12,
                  fontWeight: AppTheme.fontWeightMedium,
                ),
              ),
            ],
            actions: Row(
              children: [
                if (selector != null) selector,
                const SizedBox(width: 12),
                DetailPageActionRow(
                  playLabel: '播放',
                  onPlay: () => _playRankSongs(_rankSongs),
                  songs: _rankSongs,
                ),
              ],
            ),
          ),
        ],
      );
    }

    return SongListScaffold(
      songs: _rankSongs,
      isLoading: _isLoadingSongs,
      backgroundColor: widget.backgroundColor,
      padding: listPadding,
      rowHorizontalPadding: 6,
      hasCommentsTab: false,
      enableDefaultDoubleTapPlay: true,
      onSongDoubleTapPlay: replacePlaylistEnabled
          ? (song) async {
              await _replacePlaybackWithRankSongs(song, _rankSongs);
            }
          : null,
      headers: [
        SliverPersistentHeader(
          pinned: true,
          delegate: _FixedHeightHeaderDelegate(
            height: _compactHeaderHeight,
            child: Container(
              color: theme.scaffoldBackgroundColor,
              child: Padding(
                padding: EdgeInsets.fromLTRB(
                  listPadding.left,
                  10,
                  listPadding.right,
                  6,
                ),
                child: Row(
                  children: [
                    if (selector != null) selector,
                    const SizedBox(width: 12),
                    Expanded(
                      child: Align(
                        alignment: Alignment.centerRight,
                        child: SingleChildScrollView(
                          scrollDirection: Axis.horizontal,
                          child: DetailPageActionRow(
                            playLabel: '播放',
                            onPlay: () => _playRankSongs(_rankSongs),
                            songs: _rankSongs,
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }

  void _showRankPicker(BuildContext context) {
    final List<PickerOption> options = _ranks.map((r) => PickerOption(
      id: r['rankid'].toString(),
      name: r['rankname'],
    )).toList();

    CustomPicker.show(
      context,
      title: '排行榜选择',
      options: options,
      selectedId: _selectedRankId.toString(),
      onSelected: (opt) {
        final id = int.parse(opt.id);
        if (id != _selectedRankId) {
          _loadRankSongs(id);
        }
      },
    );
  }

}

class _FixedHeightHeaderDelegate extends SliverPersistentHeaderDelegate {
  final Widget child;
  final double height;

  _FixedHeightHeaderDelegate({required this.child, required this.height});

  @override
  Widget build(
    BuildContext context,
    double shrinkOffset,
    bool overlapsContent,
  ) {
    return SizedBox.expand(child: child);
  }

  @override
  double get maxExtent => height;

  @override
  double get minExtent => height;

  @override
  bool shouldRebuild(covariant _FixedHeightHeaderDelegate oldDelegate) {
    return oldDelegate.height != height || oldDelegate.child != child;
  }
}
