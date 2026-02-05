import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import '../../api/music_api.dart';
import '../../models/song.dart';
import '../../providers/selection_provider.dart';
import '../widgets/song_card.dart';
import '../widgets/batch_action_bar.dart';

class RankView extends StatefulWidget {
  final int? initialRankId;
  final Color? backgroundColor;
  const RankView({super.key, this.initialRankId, this.backgroundColor});

  @override
  State<RankView> createState() => _RankViewState();
}

class _RankViewState extends State<RankView> {
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

  Future<void> _loadRanks() async {
    final ranks = await MusicApi.getRanks();
    if (mounted) {
      setState(() {
        _ranks = ranks;
        _isLoadingRanks = false;
        if (_ranks.isNotEmpty) {
          _selectedRankId = widget.initialRankId ?? _ranks.first['rankid'];
          _loadRankSongs(_selectedRankId!);
        }
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
    final theme = Theme.of(context);
    final selectionProvider = context.watch<SelectionProvider>();
    final bgColor = widget.backgroundColor ?? theme.scaffoldBackgroundColor;

    if (_isLoadingRanks) {
      return Scaffold(
        backgroundColor: bgColor,
        body: const Center(child: CupertinoActivityIndicator()),
      );
    }

    return Scaffold(
        backgroundColor: bgColor,
        body: Stack(
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 40, vertical: 20),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Text(
                      '排行榜',
                      style: TextStyle(
                        fontSize: 24,
                        fontWeight: FontWeight.w800,
                        color: theme.colorScheme.onSurface,
                        letterSpacing: -0.5,
                      ),
                    ),
                    const SizedBox(width: 16),
                    if (_ranks.isNotEmpty)
                      _buildRankSelector(context),
                    const Spacer(),
                    if (!selectionProvider.isSelectionMode && _rankSongs.isNotEmpty)
                      IconButton(
                        icon: const Icon(CupertinoIcons.checkmark_circle, size: 20),
                        onPressed: () {
                          selectionProvider.setSongList(_rankSongs);
                          selectionProvider.enterSelectionMode();
                        },
                        color: theme.colorScheme.onSurfaceVariant,
                        tooltip: '批量选择',
                      ),
                  ],
                ),
                const SizedBox(height: 24),
                Expanded(
                  child: _isLoadingSongs
                      ? const Center(child: CupertinoActivityIndicator())
                      : _buildSongGrid(context),
                ),
              ],
            ),
          ),
          const BatchActionBar(),
        ],
      ),
    );
  }

  Widget _buildRankSelector(BuildContext context) {
    final theme = Theme.of(context);
    final selectedRank = _ranks.firstWhere((r) => r['rankid'] == _selectedRankId, orElse: () => _ranks.first);
    
    return InkWell(
      onTap: () => _showRankPicker(context),
      borderRadius: BorderRadius.circular(20),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        decoration: BoxDecoration(
          color: theme.colorScheme.onSurface.withAlpha(10),
          borderRadius: BorderRadius.circular(20),
          border: Border.all(color: theme.colorScheme.outlineVariant),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              selectedRank['rankname'],
              style: TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w600,
                color: theme.colorScheme.onSurface.withAlpha(200),
              ),
            ),
            const SizedBox(width: 8),
            Icon(CupertinoIcons.chevron_down, size: 14, color: theme.colorScheme.onSurfaceVariant),
          ],
        ),
      ),
    );
  }

  void _showRankPicker(BuildContext context) {
    showModalBottomSheet(
      context: context,
      backgroundColor: Colors.transparent,
      isScrollControlled: true,
      builder: (context) {
        final theme = Theme.of(context);
        return Container(
          constraints: BoxConstraints(
            maxHeight: MediaQuery.of(context).size.height * 0.6,
          ),
          decoration: BoxDecoration(
            color: theme.colorScheme.surface,
            borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const SizedBox(height: 12),
              Container(
                width: 36,
                height: 4,
                decoration: BoxDecoration(
                  color: theme.colorScheme.onSurface.withAlpha(30),
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(24, 20, 24, 16),
                child: Row(
                  children: [
                    Text(
                      '选择排行榜',
                      style: theme.textTheme.titleMedium?.copyWith(
                        fontSize: 16,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    const Spacer(),
                    Text(
                      '共 ${_ranks.length} 个',
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ],
                ),
              ),
              Flexible(
                child: GridView.builder(
                  padding: const EdgeInsets.fromLTRB(20, 0, 20, 32),
                  shrinkWrap: true,
                  gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                    crossAxisCount: 4,
                    childAspectRatio: 2.8,
                    crossAxisSpacing: 8,
                    mainAxisSpacing: 8,
                  ),
                  itemCount: _ranks.length,
                  itemBuilder: (context, index) {
                    final rank = _ranks[index];
                    final isSelected = rank['rankid'] == _selectedRankId;
                    return Material(
                      color: Colors.transparent,
                      child: InkWell(
                        onTap: () {
                          Navigator.pop(context);
                          if (!isSelected) {
                            _loadRankSongs(rank['rankid']);
                          }
                        },
                        borderRadius: BorderRadius.circular(10),
                        child: Container(
                          decoration: BoxDecoration(
                            color: isSelected 
                              ? theme.colorScheme.primary.withAlpha(20)
                              : theme.colorScheme.onSurface.withAlpha(8),
                            borderRadius: BorderRadius.circular(10),
                            border: Border.all(
                              color: isSelected 
                                ? theme.colorScheme.primary.withAlpha(100)
                                : Colors.transparent,
                              width: 1,
                            ),
                          ),
                          child: Center(
                            child: Text(
                              rank['rankname'],
                              textAlign: TextAlign.center,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                fontSize: 12,
                                fontWeight: isSelected ? FontWeight.w800 : FontWeight.w600,
                                color: isSelected 
                                  ? theme.colorScheme.primary 
                                  : theme.colorScheme.onSurface.withAlpha(200),
                              ),
                            ),
                          ),
                        ),
                      ),
                    );
                  },
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  Widget _buildSongGrid(BuildContext context) {
    if (_rankSongs.isEmpty) {
      return const Center(child: Text('暂无歌曲'));
    }

    final selectionProvider = context.watch<SelectionProvider>();

    return GridView.builder(
      physics: const BouncingScrollPhysics(),
      gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
        maxCrossAxisExtent: 400,
        mainAxisSpacing: 8,
        crossAxisSpacing: 16,
        mainAxisExtent: 72,
      ),
      itemCount: _rankSongs.length,
      itemBuilder: (context, index) {
        final song = _rankSongs[index];
        return SongCard(
          song: song,
          playlist: _rankSongs,
          showCover: true,
          coverSize: 44,
          showMore: false,
          isSelectionMode: selectionProvider.isSelectionMode,
          isSelected: selectionProvider.isSelected(song.hash),
          onSelectionChanged: (selected) {
            selectionProvider.toggleSelection(song.hash);
          },
        );
      },
    );
  }
}