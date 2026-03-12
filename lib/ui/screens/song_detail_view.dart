import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import '../../models/song.dart';
import '../../api/music_api.dart';
import '../../utils/constants.dart';
import '../widgets/cover_image.dart';
import '../widgets/back_to_top.dart';
import '../widgets/custom_tab_bar.dart';
import '../widgets/comment_item.dart';

class SongDetailView extends StatefulWidget {
  final Song song;

  const SongDetailView({super.key, required this.song});

  @override
  State<SongDetailView> createState() => _SongDetailViewState();
}

class _SongDetailViewState extends State<SongDetailView> with TickerProviderStateMixin {
  late final TabController _tabController;
  bool _isDetailLoading = true;
  bool _isCommentsLoading = false;
  bool _didLoadComments = false;
  Map<String, dynamic>? _privilegeData;
  Map<String, dynamic>? _rankingData;
  Map<String, dynamic>? _favoriteData;
  final ScrollController _scrollController = ScrollController();

  // 评论相关
  bool _isFetchingMore = false;
  bool _hasMore = true;
  int _currentPage = 1;
  static const int _pageSize = 30;
  final List<dynamic> _allComments = [];
  List<dynamic> _hotComments = [];
  int _totalCount = 0;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this)
      ..addListener(_handleTabChange);
    _scrollController.addListener(_handleScroll);
    _fetchData();
  }

  @override
  void dispose() {
    _tabController.removeListener(_handleTabChange);
    _tabController.dispose();
    _scrollController.removeListener(_handleScroll);
    _scrollController.dispose();
    super.dispose();
  }

  void _handleTabChange() {
    if (_tabController.indexIsChanging) return;
    if (_tabController.index == 1 && !_didLoadComments && !_isCommentsLoading) {
      _fetchComments(isRefresh: true);
    }
    if (mounted) setState(() {});
  }

  void _handleScroll() {
    if (!_scrollController.hasClients || _tabController.index != 1) return;
    if (_scrollController.position.extentAfter > 400) return;
    if (!_isCommentsLoading && !_isFetchingMore && _hasMore) {
      _fetchComments();
    }
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
          _isDetailLoading = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() => _isDetailLoading = false);
      }
    }
  }

  Future<void> _fetchComments({bool isRefresh = false}) async {
    if (_isFetchingMore && !isRefresh) return;

    setState(() {
      if (isRefresh) {
        _isCommentsLoading = true;
        _currentPage = 1;
        _allComments.clear();
        _hotComments.clear();
      } else {
        _isFetchingMore = true;
      }
    });

    try {
      final data = await MusicApi.getMusicComments(
        widget.song.mixSongId,
        page: _currentPage,
        pagesize: _pageSize,
        showClassify: isRefresh,
        showHotwordList: isRefresh,
      );

      if (!mounted) return;

      final List comments = data['list'] ?? [];
      final int count = data['count'] ?? 0;

      setState(() {
        if (isRefresh) {
          _hotComments = (data['hot_list'] ?? []) as List<dynamic>;
          _totalCount = count;
          _didLoadComments = true;
        }

        _allComments.addAll(comments);
        _hasMore = comments.length >= _pageSize;
        _currentPage++;
        _isCommentsLoading = false;
        _isFetchingMore = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _isCommentsLoading = false;
        _isFetchingMore = false;
        _didLoadComments = true;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Scaffold(
      backgroundColor: theme.scaffoldBackgroundColor,
      body: Stack(
        children: [
          CustomScrollView(
            controller: _scrollController,
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
                                  color: theme.colorScheme.primary,
                                ),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                              const SizedBox(height: 14),
                              _buildHeaderMetaWrap(context),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
              SliverPersistentHeader(
                pinned: true,
                delegate: _StickyTabBarDelegate(
                  child: Container(
                    color: theme.scaffoldBackgroundColor,
                    child: CustomTabBar(
                      controller: _tabController,
                      tabs: const ['详情', '评论'],
                    ),
                  ),
                ),
              ),
              SliverFillRemaining(
                child: TabBarView(
                  controller: _tabController,
                  children: [
                    _buildDetailTab(context),
                    _buildCommentTab(context),
                  ],
                ),
              ),
            ],
          ),
          BackToTop(controller: _scrollController),
        ],
      ),
    );
  }

  Widget _buildDetailTab(BuildContext context) {
    if (_isDetailLoading) {
      return const Center(child: Padding(padding: EdgeInsets.only(top: 100), child: CupertinoActivityIndicator()));
    }
    return SingleChildScrollView(
      physics: const NeverScrollableScrollPhysics(),
      child: _buildContent(context),
    );
  }

  Widget _buildCommentTab(BuildContext context) {
    final theme = Theme.of(context);

    if (_isCommentsLoading && _allComments.isEmpty) {
      return const Center(child: CupertinoActivityIndicator());
    }

    return ListView.builder(
      physics: const NeverScrollableScrollPhysics(),
      padding: EdgeInsets.zero,
      itemCount: _hotComments.length + _allComments.length + (_isFetchingMore ? 1 : 0) + 3,
      itemBuilder: (context, index) {
        if (index == 0 && _hotComments.isNotEmpty) {
          return Padding(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
            child: Text(
              '热门评论',
              style: TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w800,
                color: theme.colorScheme.onSurface.withAlpha(150),
              ),
            ),
          );
        }

        if (index > 0 && index <= _hotComments.length) {
          return CommentItem(comment: _hotComments[index - 1]);
        }

        final allCommentsStartIndex = _hotComments.isEmpty ? 1 : _hotComments.length + 1;
        if (index == allCommentsStartIndex) {
          return Padding(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
            child: Text(
              '最新评论 ${_totalCount > 0 ? '($_totalCount)' : ''}',
              style: TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w800,
                color: theme.colorScheme.onSurface.withAlpha(150),
              ),
            ),
          );
        }

        final commentIndex = index - allCommentsStartIndex - 1;
        if (commentIndex >= 0 && commentIndex < _allComments.length) {
          return CommentItem(comment: _allComments[commentIndex]);
        }

        if (_isFetchingMore && index == _hotComments.length + _allComments.length + 2) {
          return const Padding(
            padding: EdgeInsets.all(16),
            child: Center(child: CupertinoActivityIndicator()),
          );
        }

        return const SizedBox(height: 40);
      },
    );
  }

  Widget _buildContent(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 16, 24, 40),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _buildQualitySection(context),
          const SizedBox(height: 40),
          _buildRankingsSection(context),
        ],
      ),
    );
  }

  Widget _buildHeaderMetaWrap(BuildContext context) {
    final String language = _privilegeData?['trans_param']?['language'] ?? '未知';

    String favoriteCount = '0';
    try {
      final favList = _favoriteData?['data']?['list'] as List?;
      if (favList != null && favList.isNotEmpty) {
        favoriteCount = favList[0]['count_text']?.toString() ?? favList[0]['count']?.toString() ?? '0';
      }
    } catch (_) {}

    return Wrap(
      spacing: 24,
      runSpacing: 12,
      children: [
        _buildMetaItem('专辑', widget.song.albumName.isEmpty ? '单曲' : widget.song.albumName),
        _buildMetaItem('语言', language),
        _buildMetaItem('累计收藏', favoriteCount),
      ],
    );
  }

  Widget _buildQualitySection(BuildContext context) {
    final List relateGoods = _privilegeData?['relate_goods'] ?? [];
    if (relateGoods.isEmpty) return const SizedBox.shrink();

    final uniqueItems = _dedupeRelateGoods(relateGoods);

    final qualityItems = uniqueItems.where((item) {
      final q = item['quality']?.toString() ?? '';
      return q.isNotEmpty && !_isAudioEffect(q);
    }).toList();

    final effectItems = uniqueItems.where((item) {
      final q = item['quality']?.toString() ?? '';
      return q.isNotEmpty && _isAudioEffect(q);
    }).toList();

    if (qualityItems.isEmpty && effectItems.isEmpty) {
      return const SizedBox.shrink();
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (qualityItems.isNotEmpty) ...[
          _buildSectionTitle('可选音质'),
          const SizedBox(height: 12),
          _buildQualityTags(context, qualityItems),
        ],
        if (qualityItems.isNotEmpty && effectItems.isNotEmpty) const SizedBox(height: 24),
        if (effectItems.isNotEmpty) ...[
          _buildSectionTitle('可用音效'),
          const SizedBox(height: 12),
          _buildQualityTags(context, effectItems),
        ],
      ],
    );
  }

  List<Map<String, dynamic>> _dedupeRelateGoods(List items) {
    final seen = <String>{};
    final result = <Map<String, dynamic>>[];

    for (final item in items) {
      if (item is! Map) continue;
      final map = Map<String, dynamic>.from(item);
      final q = map['quality']?.toString() ?? '';
      if (q.isEmpty || seen.contains(q)) continue;
      seen.add(q);
      result.add(map);
    }

    return result;
  }

  Widget _buildQualityTags(BuildContext context, List items) {
    final theme = Theme.of(context);
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: items.map((item) {
        final q = item['quality']?.toString() ?? '';
        final label = _getQualityLabel(q);
        return Container(
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
          decoration: BoxDecoration(
            color: theme.colorScheme.primary.withAlpha(10),
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: theme.colorScheme.primary.withAlpha(20)),
          ),
          child: Text(
            label,
            style: TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w700,
              color: theme.colorScheme.primary,
            ),
          ),
        );
      }).toList(),
    );
  }

  bool _isAudioEffect(String q) {
    return q != AudioEffect.none.value &&
        AudioEffect.options.any((effect) => effect.value == q);
  }

  String _getQualityLabel(String q) {
    if (_isAudioEffect(q)) {
      return AudioEffect.getLabel(q);
    }

    return AudioQuality.getLabelOrRaw(q);
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

class _StickyTabBarDelegate extends SliverPersistentHeaderDelegate {
  final Widget child;

  _StickyTabBarDelegate({required this.child});

  @override
  double get minExtent => 48;

  @override
  double get maxExtent => 48;

  @override
  Widget build(BuildContext context, double shrinkOffset, bool overlapsContent) {
    return child;
  }

  @override
  bool shouldRebuild(_StickyTabBarDelegate oldDelegate) {
    return false;
  }
}
