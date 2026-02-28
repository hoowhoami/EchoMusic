import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import '../../models/song.dart';
import '../../api/music_api.dart';
import 'custom_dialog.dart';
import 'cover_image.dart';
import 'custom_tab_bar.dart';

class SongDetailDialog extends StatefulWidget {
  final Song song;

  const SongDetailDialog({super.key, required this.song});

  static void show(BuildContext context, Song song) {
    showDialog(
      context: context,
      builder: (context) => SongDetailDialog(song: song),
    );
  }

  @override
  State<SongDetailDialog> createState() => _SongDetailDialogState();
}

class _SongDetailDialogState extends State<SongDetailDialog> with TickerProviderStateMixin {
  bool _isLoading = true;
  Map<String, dynamic>? _privilegeData;
  Map<String, dynamic>? _rankingData;
  Map<String, dynamic>? _favoriteData;
  Map<String, dynamic>? _commentsData;
  late TabController _tabController;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 3, vsync: this);
    _fetchData();
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  Future<void> _fetchData() async {
    try {
      final results = await Future.wait([
        MusicApi.getSongPrivilege(widget.song.hash),
        MusicApi.getSongRanking(widget.song.mixSongId),
        MusicApi.getFavoriteCount(widget.song.mixSongId.toString()),
        MusicApi.getMusicComments(widget.song.mixSongId, pagesize: 50),
      ]);

      if (mounted) {
        setState(() {
          final privilegeList = results[0] as List;
          _privilegeData = privilegeList.isNotEmpty ? privilegeList[0] as Map<String, dynamic> : null;
          _rankingData = results[1] as Map<String, dynamic>;
          _favoriteData = results[2] as Map<String, dynamic>;
          _commentsData = results[3] as Map<String, dynamic>;
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
    return CustomDialog(
      title: '歌曲详情',
      confirmText: '确定',
      onConfirm: () => Navigator.pop(context),
      width: 800,
      contentWidget: SizedBox(
        height: 700,
        child: _isLoading
            ? const Center(child: CupertinoActivityIndicator())
            : _buildMainLayout(context),
      ),
    );
  }

  Widget _buildMainLayout(BuildContext context) {
    return Column(
      children: [
        _buildCompactDashboard(context),
        const SizedBox(height: 16),
        CustomTabBar(
          controller: _tabController,
          tabs: const ['榜单成就', '精彩评论', '全部评论'],
        ),
        const SizedBox(height: 12),
        Expanded(
          child: TabBarView(
            controller: _tabController,
            children: [
              _buildRankingsTab(context),
              _buildHotCommentsTab(context),
              _buildAllCommentsTab(context),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildCompactDashboard(BuildContext context) {
    final theme = Theme.of(context);
    final String language = _privilegeData?['trans_param']?['language'] ?? '未知';
    final String publishTime = _privilegeData?['publish_time'] ?? '未知';
    final starCmts = _commentsData?['star_cmts'];
    final Map? firstStarCmt = (starCmts != null && (starCmts['list'] as List).isNotEmpty) 
        ? starCmts['list'][0] as Map 
        : null;

    String favoriteCount = '0';
    try {
      final favList = _favoriteData?['data']?['list'] as List?;
      if (favList != null && favList.isNotEmpty) {
        favoriteCount = favList[0]['count_text']?.toString() ?? favList[0]['count']?.toString() ?? '0';
      }
    } catch (_) {}

    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        CoverImage(
          url: widget.song.cover,
          width: 140,
          height: 140,
          borderRadius: 20,
          size: 400,
          showShadow: true,
        ),
        const SizedBox(width: 24),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(widget.song.name, style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w900, letterSpacing: -0.8), maxLines: 1, overflow: TextOverflow.ellipsis),
                        const SizedBox(height: 2),
                        Text(widget.song.singerName, style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: theme.colorScheme.primary)),
                      ],
                    ),
                  ),
                  _buildSimpleMetric(context, '累计收藏', favoriteCount, Colors.redAccent),
                ],
              ),
              const SizedBox(height: 12),
              Wrap(
                spacing: 20, runSpacing: 4,
                children: [
                  _buildMetaText('专辑', widget.song.albumName.isEmpty ? "单曲" : widget.song.albumName),
                  _buildMetaText('语言', language),
                  _buildMetaText('发行', publishTime),
                  if (widget.song.qualityTag.isNotEmpty)
                    _buildMetaText('音质', widget.song.qualityTag),
                ],
              ),
              const SizedBox(height: 12),
              if (firstStarCmt != null)
                _buildCompactSingerQuote(context, firstStarCmt)
              else
                _buildMiniEmptyIntro(context),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildMetaText(String label, String value) {
    final theme = Theme.of(context);
    return RichText(
      text: TextSpan(
        style: const TextStyle(fontSize: 11, letterSpacing: 0.2),
        children: [
          TextSpan(text: '$label：', style: TextStyle(color: theme.colorScheme.onSurface.withAlpha(120), fontWeight: FontWeight.w600)),
          TextSpan(text: value, style: TextStyle(color: theme.colorScheme.onSurface, fontWeight: FontWeight.w800)),
        ],
      ),
    );
  }

  Widget _buildRankingsTab(BuildContext context) {
    final List rankingInfo = _rankingData?['data']?['info'] is List ? _rankingData!['data']!['info'] : [];
    if (rankingInfo.isEmpty) return _buildEmptyState(context, '暂无榜单成就', CupertinoIcons.gift);

    return GridView.builder(
      padding: const EdgeInsets.only(right: 8, bottom: 20),
      gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
        crossAxisCount: 2,
        mainAxisSpacing: 16,
        crossAxisSpacing: 16,
        mainAxisExtent: 100, // 增加高度以容纳完整数据
      ),
      itemCount: rankingInfo.length,
      itemBuilder: (context, index) {
        final rank = rankingInfo[index];
        final theme = Theme.of(context);
        
        return Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: theme.colorScheme.onSurface.withAlpha(5),
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: theme.colorScheme.onSurface.withAlpha(5)),
          ),
          child: Row(
            children: [
              Container(
                width: 60,
                height: 60,
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(12),
                  boxShadow: [BoxShadow(color: Colors.black.withAlpha(8), blurRadius: 6, offset: const Offset(0, 2))],
                ),
                clipBehavior: Clip.antiAlias, // 确保图标不出界
                child: Image.network(
                  rank['platform_logo'] ?? '',
                  fit: BoxFit.cover, // 铺满显示
                  errorBuilder: (_,_,_) => const Center(child: Icon(CupertinoIcons.music_note, size: 24, color: Colors.grey)),
                ),
              ),
              const SizedBox(width: 16),
              Expanded(
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(rank['platform_name'] ?? '', style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w900), maxLines: 1),
                    const SizedBox(height: 4),
                    Text('第 ${rank['ranking_num']} 名', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w900, color: theme.colorScheme.primary)),
                    const SizedBox(height: 2),
                    Row(
                      children: [
                        Text('上榜 ${rank['ranking_times']}次', style: const TextStyle(fontSize: 10, fontWeight: FontWeight.bold, color: Colors.grey)),
                        const SizedBox(width: 8),
                        Text(rank['last_time'] ?? '', style: const TextStyle(fontSize: 10, color: Colors.grey)),
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  Widget _buildHotCommentsTab(BuildContext context) {
    final starCmts = _commentsData?['star_cmts'];
    final List starList = (starCmts != null && starCmts['list'] is List) ? starCmts['list'] : [];
    final List normalList = _commentsData?['list'] is List ? _commentsData!['list'] : [];
    final hotList = normalList.take(15).toList();

    if (starList.isEmpty && hotList.isEmpty) return _buildEmptyState(context, '暂无精彩评论', CupertinoIcons.chat_bubble_text);

    return ListView(
      padding: const EdgeInsets.only(right: 8, bottom: 20),
      children: [
        if (starList.isNotEmpty) ...[
          _buildSectionHeader('歌手留言'),
          ...starList.map((cmt) => _buildCommentItem(context, cmt, isStar: true)),
          const SizedBox(height: 12),
        ],
        if (hotList.isNotEmpty) ...[
          _buildSectionHeader('精彩评论区'),
          ...hotList.map((cmt) => _buildCommentItem(context, cmt)),
        ],
      ],
    );
  }

  Widget _buildAllCommentsTab(BuildContext context) {
    final List normalList = _commentsData?['list'] is List ? _commentsData!['list'] : [];
    if (normalList.isEmpty) return _buildEmptyState(context, '暂无评论', CupertinoIcons.chat_bubble_text);

    return ListView.builder(
      padding: const EdgeInsets.only(right: 8, bottom: 20),
      itemCount: normalList.length,
      itemBuilder: (context, index) => _buildCommentItem(context, normalList[index]),
    );
  }

  Widget _buildCommentItem(BuildContext context, Map comment, {bool isStar = false}) {
    final theme = Theme.of(context);
    final likeCount = comment['like']?['count'] ?? 0;
    
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: isStar ? theme.colorScheme.primary.withAlpha(8) : theme.colorScheme.onSurface.withAlpha(5),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(14),
                child: Image.network(comment['user_pic'] ?? '', width: 34, height: 34, errorBuilder: (_,__,___) => const Icon(CupertinoIcons.person_alt_circle, size: 34)),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Text(comment['user_name'] ?? '匿名用户', style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w800)),
                        if (isStar)
                          Container(
                            margin: const EdgeInsets.only(left: 6),
                            padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                            decoration: BoxDecoration(color: theme.colorScheme.primary, borderRadius: BorderRadius.circular(4)),
                            child: const Text('歌手', style: TextStyle(fontSize: 8, color: Colors.white, fontWeight: FontWeight.bold)),
                          ),
                      ],
                    ),
                    Text(comment['addtime']?.toString() ?? '', style: TextStyle(fontSize: 9, color: theme.colorScheme.onSurface.withAlpha(80))),
                  ],
                ),
              ),
              _buildLikeBadge(context, likeCount),
            ],
          ),
          const SizedBox(height: 10),
          Text(comment['content'] ?? '', style: const TextStyle(fontSize: 13.5, height: 1.5, fontWeight: FontWeight.w500)),
        ],
      ),
    );
  }

  Widget _buildSectionHeader(String title) {
    return Padding(
      padding: const EdgeInsets.only(left: 4, bottom: 8),
      child: Text(title, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w900, color: Colors.grey)),
    );
  }

  Widget _buildCompactSingerQuote(BuildContext context, Map cmt) {
    final theme = Theme.of(context);
    return InkWell(
      onTap: () => _tabController.animateTo(1),
      borderRadius: BorderRadius.circular(12),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: theme.colorScheme.primary.withAlpha(8),
          borderRadius: const BorderRadius.only(topRight: Radius.circular(12), bottomLeft: Radius.circular(12), bottomRight: Radius.circular(12)),
          border: Border.all(color: theme.colorScheme.primary.withAlpha(12)),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Icon(CupertinoIcons.quote_bubble_fill, size: 12, color: theme.colorScheme.primary),
                const SizedBox(width: 6),
                Text('歌手留言精选', style: TextStyle(fontSize: 10, fontWeight: FontWeight.w900, color: theme.colorScheme.primary)),
                const Spacer(),
                Text('查看全文', style: TextStyle(fontSize: 9, color: theme.colorScheme.primary.withAlpha(150), fontWeight: FontWeight.bold)),
                Icon(CupertinoIcons.chevron_right, size: 9, color: theme.colorScheme.primary.withAlpha(150)),
              ],
            ),
            const SizedBox(height: 4),
            Text(cmt['content'] ?? '', maxLines: 2, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 11, color: theme.colorScheme.onSurface.withAlpha(160), height: 1.4)),
          ],
        ),
      ),
    );
  }

  Widget _buildMiniEmptyIntro(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(color: Theme.of(context).colorScheme.onSurface.withAlpha(5), borderRadius: BorderRadius.circular(12)),
      child: Text('暂无更多介绍 ~', style: TextStyle(fontSize: 11, color: Theme.of(context).colorScheme.onSurface.withAlpha(80))),
    );
  }

  Widget _buildSimpleMetric(BuildContext context, String label, String value, Color color) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        Text(label, style: TextStyle(fontSize: 9, color: color.withAlpha(150), fontWeight: FontWeight.w800)),
        Text(value, style: TextStyle(fontSize: 18, fontWeight: FontWeight.w900, color: color, height: 1.1)),
      ],
    );
  }

  Widget _buildLikeBadge(BuildContext context, int count) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
      decoration: BoxDecoration(
        color: theme.colorScheme.surface,
        borderRadius: BorderRadius.circular(20),
        boxShadow: [BoxShadow(color: Colors.black.withAlpha(5), blurRadius: 4, offset: const Offset(0, 1))],
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(CupertinoIcons.hand_thumbsup_fill, size: 11, color: theme.colorScheme.primary),
          const SizedBox(width: 5),
          Text(_formatBigNumber(count), style: TextStyle(fontSize: 10, fontWeight: FontWeight.w900, color: theme.colorScheme.primary)),
        ],
      ),
    );
  }

  Widget _buildEmptyState(BuildContext context, String msg, IconData icon) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(icon, size: 40, color: Theme.of(context).disabledColor.withAlpha(50)),
          const SizedBox(height: 12),
          Text(msg, style: TextStyle(color: Theme.of(context).disabledColor, fontSize: 13)),
        ],
      ),
    );
  }

  String _formatBigNumber(int number) {
    if (number < 10000) return number.toString();
    return '${(number / 10000).toStringAsFixed(1)}w';
  }
}
