import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import '../../models/song.dart';
import '../../api/music_api.dart';
import '../../providers/navigation_provider.dart';
import '../../utils/format_utils.dart';
import '../widgets/cover_image.dart';
import 'song_comment_view.dart';

class SongDetailView extends StatefulWidget {
  final Song song;

  const SongDetailView({super.key, required this.song});

  @override
  State<SongDetailView> createState() => _SongDetailViewState();
}

class _SongDetailViewState extends State<SongDetailView> {
  bool _isLoading = true;
  Map<String, dynamic>? _privilegeData;
  Map<String, dynamic>? _rankingData;
  Map<String, dynamic>? _favoriteData;

  @override
  void initState() {
    super.initState();
    _fetchData();
  }

  Future<void> _fetchData() async {
    try {
      final results = await Future.wait([
        MusicApi.getSongPrivilege(widget.song.hash),
        MusicApi.getSongRanking(widget.song.mixSongId),
        MusicApi.getFavoriteCount(widget.song.mixSongId.toString()),
      ]);

      if (mounted) {
        setState(() {
          final privilegeList = results[0] as List;
          _privilegeData = privilegeList.isNotEmpty ? privilegeList[0] as Map<String, dynamic> : null;
          _rankingData = results[1] as Map<String, dynamic>;
          _favoriteData = results[2] as Map<String, dynamic>;
          _isLoading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() => _isLoading = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    
    return Scaffold(
      backgroundColor: theme.scaffoldBackgroundColor,
      body: CustomScrollView(
        slivers: [
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
                          CoverImage(
                            url: widget.song.cover,
                            width: 32,
                            height: 32,
                            borderRadius: 6,
                            showShadow: false,
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Text(
                              widget.song.name,
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
                      url: widget.song.cover,
                      width: 130,
                      height: 130,
                      borderRadius: 16,
                      showShadow: true,
                    ),
                    const SizedBox(width: 24),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Text(
                            'SONG',
                            style: TextStyle(
                              color: theme.colorScheme.primary,
                              fontSize: 10,
                              fontWeight: FontWeight.w900,
                              letterSpacing: 2.0,
                            ),
                          ),
                          const SizedBox(height: 4),
                          Text(
                            widget.song.name,
                            style: theme.textTheme.titleLarge?.copyWith(
                              fontSize: 22,
                              fontWeight: FontWeight.w900,
                              height: 1.1,
                            ),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                          const SizedBox(height: 8),
                          Text(
                            widget.song.singerName,
                            style: TextStyle(
                              fontSize: 14, 
                              fontWeight: FontWeight.w700, 
                              color: theme.colorScheme.primary
                            ),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
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
            child: _isLoading
                ? const Center(child: Padding(padding: EdgeInsets.only(top: 100), child: CupertinoActivityIndicator()))
                : _buildContent(context),
          ),
        ],
      ),
    );
  }

  Widget _buildContent(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 16, 24, 40),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _buildInfoGrid(context),
          const SizedBox(height: 32),
          _buildQualitySection(context),
          const SizedBox(height: 40),
          _buildRankingsSection(context),
        ],
      ),
    );
  }

  Widget _buildInfoGrid(BuildContext context) {
    final theme = Theme.of(context);
    final String language = _privilegeData?['trans_param']?['language'] ?? '未知';
    final int bitrate = _privilegeData?['info']?['bitrate'] ?? 0;
    final int filesize = _privilegeData?['info']?['filesize'] ?? 0;
    final String ext = _privilegeData?['info']?['extname']?.toString().toUpperCase() ?? 'MP3';

    String favoriteCount = '0';
    try {
      final favList = _favoriteData?['data']?['list'] as List?;
      if (favList != null && favList.isNotEmpty) {
        favoriteCount = favList[0]['count_text']?.toString() ?? favList[0]['count']?.toString() ?? '0';
      }
    } catch (_) {}

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _buildSectionTitle('音频档案'),
        const SizedBox(height: 16),
        Wrap(
          spacing: 40,
          runSpacing: 20,
          children: [
            _buildMetaItem('专辑', widget.song.albumName.isEmpty ? "单曲" : widget.song.albumName),
            _buildMetaItem('语言', language),
            _buildMetaItem('格式', ext),
            if (bitrate > 0) _buildMetaItem('比特率', '${bitrate}kbps'),
            if (filesize > 0) _buildMetaItem('文件大小', formatBytes(filesize)),
            _buildMetaItem('累计收藏', favoriteCount),
          ],
        ),
      ],
    );
  }

  Widget _buildQualitySection(BuildContext context) {
    final List relateGoods = _privilegeData?['relate_goods'] ?? [];
    if (relateGoods.isEmpty) return const SizedBox.shrink();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _buildSectionTitle('可选音质'),
        const SizedBox(height: 12),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: relateGoods.map((item) {
            String q = item['quality']?.toString() ?? '';
            String label = _getQualityLabel(q);
            return Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              decoration: BoxDecoration(
                color: Theme.of(context).colorScheme.primary.withAlpha(10),
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: Theme.of(context).colorScheme.primary.withAlpha(20)),
              ),
              child: Text(
                label,
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w700,
                  color: Theme.of(context).colorScheme.primary,
                ),
              ),
            );
          }).toList(),
        ),
      ],
    );
  }

  String _getQualityLabel(String q) {
    switch (q) {
      case '128': return '标准 (128K)';
      case '320': return '极高 (320K)';
      case 'flac':
      case 'high': return '无损 (FLAC)';
      case 'viper_atmos': return '杜比全景声';
      case 'viper_tape': return '磁带音效';
      case 'viper_clear': return '清澈人声';
      default: return q.toUpperCase();
    }
  }

  Widget _buildSectionTitle(String title) {
    return Text(
      title,
      style: const TextStyle(
        fontSize: 13,
        fontWeight: FontWeight.w900,
        color: Colors.grey,
        letterSpacing: 1.2,
      ),
    );
  }

  Widget _buildMetaItem(String label, String value) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: TextStyle(fontSize: 12, color: theme.colorScheme.onSurface.withAlpha(100), fontWeight: FontWeight.w600)),
        const SizedBox(height: 4),
        Text(value, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w800)),
      ],
    );
  }

  Widget _buildRankingsSection(BuildContext context) {
    final List rankingInfo = _rankingData?['data']?['info'] is List ? _rankingData!['data']!['info'] : [];
    final String? summary = _rankingData?['data']?['title2'];
    
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const Icon(CupertinoIcons.gift_fill, size: 20, color: Colors.amber),
            const SizedBox(width: 8),
            const Text('榜单成就', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w900)),
            if (summary != null) ...[
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  '• $summary',
                  style: TextStyle(fontSize: 12, color: Theme.of(context).disabledColor, fontWeight: FontWeight.w500),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ],
        ),
        const SizedBox(height: 20),
        if (rankingInfo.isEmpty)
          _buildEmptyRankings(context)
        else
          ListView.separated(
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            itemCount: rankingInfo.length,
            separatorBuilder: (context, index) => const SizedBox(height: 16),
            itemBuilder: (context, index) => _buildRankCard(context, rankingInfo[index]),
          ),
      ],
    );
  }

  Widget _buildRankCard(BuildContext context, Map rank) {
    final theme = Theme.of(context);
    final String lastTime = rank['last_time']?.toString() ?? '未知';
    final int currentRank = rank['ranking_num'] ?? 0;
    final int rankingTimes = rank['ranking_times'] ?? 0;

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 20),
      decoration: BoxDecoration(
        color: theme.colorScheme.onSurface.withAlpha(10),
        borderRadius: BorderRadius.circular(24),
        border: Border.all(color: theme.colorScheme.onSurface.withAlpha(5)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  rank['platform_name'] ?? '未知平台',
                  style: const TextStyle(
                    fontSize: 18,
                    fontWeight: FontWeight.w900,
                  ),
                ),
                const SizedBox(height: 10),
                Wrap(
                  spacing: 24,
                  runSpacing: 4,
                  children: [
                    _buildInfoText(context, '累计上榜', '$rankingTimes次'),
                    _buildInfoText(context, '最近上榜', lastTime),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(width: 12),
          Text(
            '第 $currentRank 名',
            style: TextStyle(
              fontSize: 22,
              fontWeight: FontWeight.w900,
              color: theme.colorScheme.primary,
              letterSpacing: -1.0,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildInfoText(BuildContext context, String label, String value) {
    final theme = Theme.of(context);
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          '$label: ',
          style: TextStyle(
            fontSize: 12, 
            color: theme.colorScheme.onSurface.withAlpha(120), 
            fontWeight: FontWeight.w600
          ),
        ),
        Text(
          value,
          style: TextStyle(
            fontSize: 12, 
            color: theme.colorScheme.onSurface, 
            fontWeight: FontWeight.w800
          ),
        ),
      ],
    );
  }


  Widget _buildEmptyRankings(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(40),
      decoration: BoxDecoration(color: Theme.of(context).colorScheme.onSurface.withAlpha(5), borderRadius: BorderRadius.circular(20)),
      child: Center(
        child: Column(
          children: [
            Icon(CupertinoIcons.gift, size: 40, color: Theme.of(context).disabledColor.withAlpha(50)),
            const SizedBox(height: 12),
            Text('暂无榜单数据', style: TextStyle(color: Theme.of(context).disabledColor, fontSize: 14)),
          ],
        ),
      ),
    );
  }
}
