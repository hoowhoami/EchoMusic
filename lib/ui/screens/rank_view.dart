import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import '../../api/music_api.dart';
import '../../models/song.dart';
import '../../providers/selection_provider.dart';
import '../widgets/song_card.dart';
import '../widgets/batch_selection_scaffold.dart';
import '../widgets/refined_picker.dart';

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
    if (ranks.isNotEmpty && mounted) {
      setState(() {
        _ranks = ranks;
        _isLoadingRanks = false;
        _selectedRankId = widget.initialRankId ?? _ranks.first['rankid'];
        _loadRankSongs(_selectedRankId!);
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

    return BatchSelectionScaffold(
      title: '排行榜',
      songs: _rankSongs,
      appBarActions: _ranks.isNotEmpty ? _buildRankSelector(context) : null,
      body: _isLoadingSongs
          ? const Center(child: CupertinoActivityIndicator())
          : _buildSongGrid(context),
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
    final List<PickerOption> options = _ranks.map((r) => PickerOption(
      id: r['rankid'].toString(),
      name: r['rankname'],
    )).toList();

    RefinedPicker.show(
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

  Widget _buildSongGrid(BuildContext context) {
    if (_rankSongs.isEmpty) {
      return const Center(child: Text('暂无歌曲'));
    }

    final selectionProvider = context.watch<SelectionProvider>();

    return GridView.builder(
      padding: const EdgeInsets.symmetric(horizontal: 28),
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