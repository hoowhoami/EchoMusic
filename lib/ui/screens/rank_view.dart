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
  const RankView({super.key, this.initialRankId});

  @override
  State<RankView> createState() => _RankViewState();
}

class _RankViewState extends State<RankView> with SingleTickerProviderStateMixin {
  List<Map<String, dynamic>> _ranks = [];
  List<Song> _rankSongs = [];
  int? _selectedRankId;
  bool _isLoadingRanks = true;
  bool _isLoadingSongs = false;
  late TabController _tabController;

  // Rank categories
  final List<String> _categories = ['全部', '流行', '摇滚', '民谣', '电子', '说唱', '古风', '二次元'];

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: _categories.length, vsync: this);
    _loadRanks();
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
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
    });
    final songs = await MusicApi.getRankSongs(rankId);
    if (mounted) {
      setState(() {
        _rankSongs = songs;
        _isLoadingSongs = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final accentColor = Theme.of(context).colorScheme.primary;
    final selectionProvider = context.watch<SelectionProvider>();

    if (_isLoadingRanks) {
      return const Center(child: CupertinoActivityIndicator());
    }

    return Column(
      children: [
        Expanded(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 40, vertical: 20),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Text(
                      '排行榜',
                      style: TextStyle(
                        fontSize: 28,
                        fontWeight: FontWeight.w700,
                        color: isDark ? Colors.white : Colors.black,
                        letterSpacing: -0.5,
                      ),
                    ),
                    const Spacer(),
                    if (!selectionProvider.isSelectionMode && _rankSongs.isNotEmpty)
                      IconButton(
                        icon: const Icon(CupertinoIcons.checkmark_circle, size: 22),
                        onPressed: () {
                          selectionProvider.setSongList(_rankSongs);
                          selectionProvider.enterSelectionMode();
                        },
                        color: isDark ? Colors.white54 : Colors.black54,
                        tooltip: '批量选择',
                      ),
                    if (_ranks.isNotEmpty)
                      _buildRankSelector(context),
                  ],
                ),
                const SizedBox(height: 20),
                TabBar(
                  controller: _tabController,
                  isScrollable: true,
                  indicatorSize: TabBarIndicatorSize.label,
                  dividerColor: Colors.transparent,
                  labelColor: accentColor,
                  unselectedLabelColor: isDark ? Colors.white38 : Colors.black38,
                  labelStyle: const TextStyle(fontWeight: FontWeight.w700, fontSize: 13),
                  unselectedLabelStyle: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13),
                  indicator: UnderlineTabIndicator(
                    borderSide: BorderSide(
                      width: 2,
                      color: accentColor,
                    ),
                    borderRadius: BorderRadius.circular(2),
                  ),
                  onTap: (index) {
                    // Could filter ranks by category
                  },
                  tabs: _categories.map((cat) => Tab(text: cat)).toList(),
                ),
                const SizedBox(height: 16),
                Expanded(
                  child: _isLoadingSongs
                      ? const Center(child: CupertinoActivityIndicator())
                      : _buildSongGrid(context),
                ),
              ],
            ),
          ),
        ),
        const BatchActionBar(),
      ],
    );
  }

  Widget _buildRankSelector(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final selectedRank = _ranks.firstWhere((r) => r['rankid'] == _selectedRankId, orElse: () => _ranks.first);
    
    return InkWell(
      onTap: () => _showRankPicker(context),
      borderRadius: BorderRadius.circular(20),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        decoration: BoxDecoration(
          color: isDark ? Colors.white.withAlpha(10) : Colors.black.withAlpha(5),
          borderRadius: BorderRadius.circular(20),
          border: Border.all(color: isDark ? Colors.white10 : Colors.black12),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              selectedRank['rankname'],
              style: TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w600,
                color: isDark ? Colors.white.withAlpha(200) : Colors.black.withAlpha(200),
              ),
            ),
            const SizedBox(width: 8),
            Icon(CupertinoIcons.chevron_down, size: 14, color: isDark ? Colors.white38 : Colors.black38),
          ],
        ),
      ),
    );
  }

  void _showRankPicker(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    
    showModalBottomSheet(
      context: context,
      backgroundColor: Colors.transparent,
      isScrollControlled: true,
      builder: (context) {
        return Container(
          height: MediaQuery.of(context).size.height * 0.7,
          decoration: BoxDecoration(
            color: isDark ? const Color(0xFF1E293B) : Colors.white,
            borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
          ),
          child: Column(
            children: [
              const SizedBox(height: 12),
              Container(
                width: 40,
                height: 4,
                decoration: BoxDecoration(
                  color: isDark ? Colors.white10 : Colors.black12,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
              const Padding(
                padding: EdgeInsets.all(24.0),
                child: Text(
                  '选择排行榜',
                  style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
                ),
              ),
              Expanded(
                child: GridView.builder(
                  padding: const EdgeInsets.symmetric(horizontal: 24),
                  gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                    crossAxisCount: 2,
                    childAspectRatio: 3,
                    crossAxisSpacing: 12,
                    mainAxisSpacing: 12,
                  ),
                  itemCount: _ranks.length,
                  itemBuilder: (context, index) {
                    final rank = _ranks[index];
                    final isSelected = rank['rankid'] == _selectedRankId;
                    return InkWell(
                      onTap: () {
                        Navigator.pop(context);
                        _loadRankSongs(rank['rankid']);
                      },
                      borderRadius: BorderRadius.circular(12),
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 16),
                        decoration: BoxDecoration(
                          color: isSelected 
                            ? Theme.of(context).primaryColor.withAlpha(20)
                            : (isDark ? Colors.white.withAlpha(5) : Colors.black.withAlpha(5)),
                          borderRadius: BorderRadius.circular(12),
                          border: Border.all(
                            color: isSelected 
                              ? Theme.of(context).primaryColor.withAlpha(100)
                              : Colors.transparent
                          ),
                        ),
                        child: Center(
                          child: Text(
                            rank['rankname'],
                            textAlign: TextAlign.center,
                            style: TextStyle(
                              fontSize: 13,
                              fontWeight: isSelected ? FontWeight.bold : FontWeight.normal,
                              color: isSelected ? Theme.of(context).primaryColor : (isDark ? Colors.white70 : Colors.black87),
                            ),
                          ),
                        ),
                      ),
                    );
                  },
                ),
              ),
              const SizedBox(height: 24),
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

    return ListView.builder(
      itemCount: _rankSongs.length,
      itemBuilder: (context, index) {
        final song = _rankSongs[index];
        return SongCard(
          song: song,
          playlist: _rankSongs,
          showMore: true,
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

