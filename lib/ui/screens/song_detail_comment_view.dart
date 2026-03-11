import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';

import '../../api/music_api.dart';
import '../../models/song.dart';
import '../../utils/constants.dart';
import '../widgets/back_to_top.dart';
import '../widgets/cover_image.dart';
import '../widgets/custom_tab_bar.dart';
import '../widgets/detail_page_sliver_header.dart';

class SongDetailCommentView extends StatefulWidget {
  const SongDetailCommentView({super.key, required this.song});

  final Song song;

  @override
  State<SongDetailCommentView> createState() => _SongDetailCommentViewState();
}

class _SongDetailCommentViewState extends State<SongDetailCommentView>
    with TickerProviderStateMixin {
  late final TabController _mainTabController;
  late final TabController _commentTabController;
  final ScrollController _scrollController = ScrollController();
  final ScrollController _classifyHeaderScrollController = ScrollController();
  final ScrollController _hotwordHeaderScrollController = ScrollController();

  bool _isDetailLoading = false;
  bool _didLoadDetail = false;
  Map<String, dynamic>? _privilegeData;
  Map<String, dynamic>? _rankingData;
  Map<String, dynamic>? _favoriteData;

  bool _isCommentsLoading = false;
  bool _didLoadComments = false;
  bool _isFetchingMore = false;
  bool _hasMore = true;
  int _currentPage = 1;
  static const int _pageSize = 30;

  Map<String, dynamic>? _commentsData;
  Map<String, dynamic>? _commentCountData;
  final List<dynamic> _allComments = [];
  List<dynamic> _hotComments = [];

  List<dynamic> _classifyList = [];
  List<dynamic> _hotWordList = [];
  final List<dynamic> _classifyComments = [];
  final List<dynamic> _hotwordComments = [];
  int _classifyPage = 1;
  int _hotwordPage = 1;
  bool _hasMoreClassify = true;
  bool _hasMoreHotword = true;
  int? _selectedClassifyId;
  String? _selectedHotWord;
  bool _isFetchingClassify = false;
  bool _isFetchingHotword = false;

  @override
  void initState() {
    super.initState();
    _mainTabController = TabController(length: 2, vsync: this)
      ..addListener(_handleMainTabChange);
    _commentTabController = TabController(length: 4, vsync: this)
      ..addListener(_handleCommentTabChange);
    _scrollController.addListener(_handleScroll);
    _fetchHeaderStats();
    _fetchDetailData();
  }

  @override
  void dispose() {
    _mainTabController.removeListener(_handleMainTabChange);
    _commentTabController.removeListener(_handleCommentTabChange);
    _mainTabController.dispose();
    _commentTabController.dispose();
    _scrollController.removeListener(_handleScroll);
    _scrollController.dispose();
    _classifyHeaderScrollController.dispose();
    _hotwordHeaderScrollController.dispose();
    super.dispose();
  }

  void _handleMainTabChange() {
    if (_mainTabController.indexIsChanging) return;

    if (_mainTabController.index == 0 && !_didLoadDetail && !_isDetailLoading) {
      _fetchDetailData();
    }
    if (_mainTabController.index == 1 &&
        !_didLoadComments &&
        !_isCommentsLoading) {
      _fetchComments(isRefresh: true);
    }
    if (mounted) {
      setState(() {});
    }
  }

  void _handleCommentTabChange() {
    if (_commentTabController.indexIsChanging) return;

    if (_commentTabController.index == 2 &&
        _classifyComments.isEmpty &&
        _classifyList.isNotEmpty) {
      _selectedClassifyId ??= _classifyList.first['id'] as int?;
      _fetchClassifyComments(isRefresh: true);
    } else if (_commentTabController.index == 3 &&
        _hotwordComments.isEmpty &&
        _hotWordList.isNotEmpty) {
      _selectedHotWord ??= _hotWordList.first['content']?.toString();
      _fetchHotwordComments(isRefresh: true);
    }

    if (mounted) {
      setState(() {});
    }
  }

  void _handleScroll() {
    if (!_scrollController.hasClients || _mainTabController.index != 1) {
      return;
    }
    if (_scrollController.position.extentAfter > 400) return;

    switch (_commentTabController.index) {
      case 1:
        if (!_isCommentsLoading && !_isFetchingMore && _hasMore) {
          _fetchComments();
        }
        break;
      case 2:
        if (!_isFetchingClassify && _hasMoreClassify) {
          _fetchClassifyComments();
        }
        break;
      case 3:
        if (!_isFetchingHotword && _hasMoreHotword) {
          _fetchHotwordComments();
        }
        break;
    }
  }

  Future<void> _fetchHeaderStats() async {
    try {
      final results = await Future.wait([
        MusicApi.getFavoriteCount(widget.song.mixSongId.toString()),
        MusicApi.getCommentCount(widget.song.hash),
      ]);

      if (!mounted) return;
      setState(() {
        _favoriteData = results[0];
        _commentCountData = results[1];
      });
    } catch (_) {
      // Ignore header stats failures and keep page usable.
    }
  }

  Future<void> _fetchDetailData() async {
    setState(() => _isDetailLoading = true);

    try {
      final results = await Future.wait([
        MusicApi.getSongPrivilege(widget.song.hash),
        MusicApi.getSongRanking(widget.song.mixSongId),
      ]);

      if (!mounted) return;
      setState(() {
        final privilegeList = results[0] as List;
        _privilegeData = privilegeList.isNotEmpty
            ? privilegeList[0] as Map<String, dynamic>
            : null;
        _rankingData = results[1] as Map<String, dynamic>;
        _isDetailLoading = false;
        _didLoadDetail = true;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _isDetailLoading = false;
        _didLoadDetail = true;
      });
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
      final payload = data['data'] is Map<String, dynamic>
          ? data['data'] as Map<String, dynamic>
          : data;
      final List newComments = payload['list'] is List ? payload['list'] : [];

      if (!mounted) return;
      setState(() {
        _commentsData = data;
        if (isRefresh) {
          _hotComments = payload['weight_list'] is List
              ? payload['weight_list'] as List<dynamic>
              : newComments.take(30).toList(growable: false);
          _classifyList = payload['classify_list'] is List
              ? payload['classify_list'] as List<dynamic>
              : [];
          _hotWordList = payload['hot_word_list'] is List
              ? payload['hot_word_list'] as List<dynamic>
              : [];
        }
        _allComments.addAll(newComments);
        final total = payload['count'] ?? payload['total'] ?? 0;
        _hasMore = total > 0
            ? _allComments.length < total
            : newComments.length >= _pageSize;
        if (_hasMore) {
          _currentPage++;
        }
        _isCommentsLoading = false;
        _isFetchingMore = false;
        _didLoadComments = true;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _isCommentsLoading = false;
        _isFetchingMore = false;
        _didLoadComments = true;
      });
    }
  }

  Future<void> _fetchClassifyComments({bool isRefresh = false}) async {
    if (_isFetchingClassify || _selectedClassifyId == null) return;

    setState(() {
      if (isRefresh) {
        _classifyPage = 1;
        _classifyComments.clear();
        _hasMoreClassify = true;
      }
      _isFetchingClassify = true;
    });

    try {
      final data = await MusicApi.getMusicClassifyComments(
        widget.song.mixSongId,
        _selectedClassifyId!,
        page: _classifyPage,
        pagesize: _pageSize,
      );
      final payload = data['data'] is Map<String, dynamic>
          ? data['data'] as Map<String, dynamic>
          : data;
      final List newComments = payload['list'] is List ? payload['list'] : [];

      if (!mounted) return;
      setState(() {
        _classifyComments.addAll(newComments);
        final selectedItem = _classifyList.cast<Map?>().firstWhere(
          (item) => item?['id'] == _selectedClassifyId,
          orElse: () => null,
        );
        final total =
            payload['count'] ??
            payload['total'] ??
            (selectedItem != null ? selectedItem['cnt'] : 0);
        _hasMoreClassify = total > 0
            ? _classifyComments.length < total
            : newComments.length >= _pageSize;
        if (_hasMoreClassify) {
          _classifyPage++;
        }
        _isFetchingClassify = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() => _isFetchingClassify = false);
    }
  }

  Future<void> _fetchHotwordComments({bool isRefresh = false}) async {
    if (_isFetchingHotword || _selectedHotWord == null) return;

    setState(() {
      if (isRefresh) {
        _hotwordPage = 1;
        _hotwordComments.clear();
        _hasMoreHotword = true;
      }
      _isFetchingHotword = true;
    });

    try {
      final data = await MusicApi.getMusicHotwordComments(
        widget.song.mixSongId,
        _selectedHotWord!,
        page: _hotwordPage,
        pagesize: _pageSize,
      );
      final payload = data['data'] is Map<String, dynamic>
          ? data['data'] as Map<String, dynamic>
          : data;
      final List newComments = payload['list'] is List ? payload['list'] : [];

      if (!mounted) return;
      setState(() {
        _hotwordComments.addAll(newComments);
        final selectedItem = _hotWordList.cast<Map?>().firstWhere(
          (item) => item?['content'] == _selectedHotWord,
          orElse: () => null,
        );
        final total =
            payload['count'] ??
            payload['total'] ??
            (selectedItem != null ? selectedItem['count'] : 0);
        _hasMoreHotword = total > 0
            ? _hotwordComments.length < total
            : newComments.length >= _pageSize;
        if (_hasMoreHotword) {
          _hotwordPage++;
        }
        _isFetchingHotword = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() => _isFetchingHotword = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Scaffold(
      backgroundColor: theme.scaffoldBackgroundColor,
      body: Stack(
        children: [
          ScrollConfiguration(
            behavior: ScrollConfiguration.of(
              context,
            ).copyWith(scrollbars: false),
            child: CustomScrollView(
              controller: _scrollController,
              slivers: [
                _buildHeader(theme),
                SliverPersistentHeader(
                  pinned: true,
                  delegate: _FixedHeaderDelegate(
                    height: 58,
                    child: Container(
                      color: theme.scaffoldBackgroundColor,
                      padding: const EdgeInsets.fromLTRB(24, 8, 24, 8),
                      child: TabBar(
                        controller: _mainTabController,
                        isScrollable: true,
                        tabAlignment: TabAlignment.start,
                        dividerColor: Colors.transparent,
                        indicatorSize: TabBarIndicatorSize.label,
                        indicator: UnderlineTabIndicator(
                          borderSide: BorderSide(
                            color: theme.colorScheme.primary,
                            width: 3,
                          ),
                        ),
                        labelPadding: const EdgeInsets.only(right: 24),
                        labelColor: theme.colorScheme.onSurface,
                        unselectedLabelColor: theme.colorScheme.onSurface
                            .withAlpha(120),
                        labelStyle: const TextStyle(
                          fontSize: 18,
                          fontWeight: FontWeight.w900,
                        ),
                        unselectedLabelStyle: const TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.w700,
                        ),
                        tabs: const [
                          Tab(text: '详情'),
                          Tab(text: '评论'),
                        ],
                      ),
                    ),
                  ),
                ),
                ..._buildBodySlivers(context),
              ],
            ),
          ),
          BackToTop(controller: _scrollController),
        ],
      ),
    );
  }

  DetailPageSliverHeader _buildHeader(ThemeData theme) {
    final commentCount = _getCommentCount();
    return DetailPageSliverHeader(
      typeLabel: 'SONG',
      title: widget.song.name,
      expandedHeight: 164,
      expandedCover: CoverImage(
        url: widget.song.cover,
        width: 136,
        height: 136,
        borderRadius: 18,
      ),
      collapsedCover: CoverImage(
        url: widget.song.cover,
        width: 32,
        height: 32,
        borderRadius: 6,
        showShadow: false,
      ),
      detailChildren: [
        Text(
          widget.song.singerName,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(
            color: theme.colorScheme.primary,
            fontSize: 14,
            fontWeight: FontWeight.w700,
          ),
        ),
        Wrap(
          spacing: 18,
          runSpacing: 8,
          children: [
            _buildMetaItem(
              '专辑',
              widget.song.albumName.isEmpty ? '单曲' : widget.song.albumName,
            ),
            _buildMetaItem(
              '语言',
              _privilegeData?['trans_param']?['language']?.toString() ?? '未知',
            ),
            _buildMetaItem('累计收藏', _getFavoriteCount()),
            _buildMetaItem('评论', commentCount),
          ],
        ),
      ],
    );
  }

  List<Widget> _buildBodySlivers(BuildContext context) {
    if (_mainTabController.index == 0) {
      return _buildDetailSlivers(context);
    }
    return _buildCommentSlivers(context);
  }

  List<Widget> _buildDetailSlivers(BuildContext context) {
    if (_isDetailLoading && !_didLoadDetail) {
      return [
        const SliverToBoxAdapter(
          child: Padding(
            padding: EdgeInsets.only(top: 72),
            child: Center(child: CupertinoActivityIndicator()),
          ),
        ),
      ];
    }

    return [
      SliverToBoxAdapter(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 12, 24, 40),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _buildQualitySection(context),
              const SizedBox(height: 40),
              _buildRankingsSection(context),
            ],
          ),
        ),
      ),
    ];
  }

  List<Widget> _buildCommentSlivers(BuildContext context) {
    final theme = Theme.of(context);
    return [
      SliverPersistentHeader(
        pinned: true,
        delegate: _FixedHeaderDelegate(
          height: 58,
          child: Container(
            color: theme.scaffoldBackgroundColor,
            padding: const EdgeInsets.fromLTRB(24, 8, 24, 8),
            child: CustomTabBar(
              controller: _commentTabController,
              tabs: const ['精彩评论', '全部评论', '分类评论', '热词评论'],
            ),
          ),
        ),
      ),
      ..._buildCommentContentSlivers(context),
    ];
  }

  List<Widget> _buildCommentContentSlivers(BuildContext context) {
    if (_isCommentsLoading && !_didLoadComments) {
      return [
        const SliverToBoxAdapter(
          child: Padding(
            padding: EdgeInsets.only(top: 72),
            child: Center(child: CupertinoActivityIndicator()),
          ),
        ),
      ];
    }

    switch (_commentTabController.index) {
      case 0:
        return _buildHotCommentSlivers(context);
      case 1:
        return _buildAllCommentSlivers(context);
      case 2:
        return _buildClassifyCommentSlivers(context);
      case 3:
        return _buildHotwordCommentSlivers(context);
      default:
        return const [];
    }
  }

  List<Widget> _buildHotCommentSlivers(BuildContext context) {
    final payload = _commentsData?['data'] is Map<String, dynamic>
        ? _commentsData!['data'] as Map<String, dynamic>
        : _commentsData;
    final starList = payload?['star_cmts']?['list'] is List
        ? payload!['star_cmts']!['list'] as List<dynamic>
        : <dynamic>[];
    if (_hotComments.isEmpty && starList.isEmpty) {
      return [
        _buildEmptyStateSliver(
          context,
          '暂无评论',
          CupertinoIcons.chat_bubble_text,
        ),
      ];
    }

    return [
      SliverPadding(
        padding: const EdgeInsets.fromLTRB(24, 12, 24, 40),
        sliver: SliverList(
          delegate: SliverChildBuilderDelegate(
            (context, index) => _buildHotCommentItem(context, index, starList),
            childCount: _calculateHotItemCount(starList),
          ),
        ),
      ),
    ];
  }

  List<Widget> _buildAllCommentSlivers(BuildContext context) {
    if (_allComments.isEmpty) {
      return [
        _buildEmptyStateSliver(
          context,
          '暂无评论',
          CupertinoIcons.chat_bubble_text,
        ),
      ];
    }

    return [
      SliverPadding(
        padding: const EdgeInsets.fromLTRB(24, 12, 24, 40),
        sliver: SliverList(
          delegate: SliverChildBuilderDelegate((context, index) {
            if (index < _allComments.length) {
              return _buildCommentItem(context, _allComments[index] as Map);
            }
            return _buildLoadingIndicator(_hasMore);
          }, childCount: _allComments.length + 1),
        ),
      ),
    ];
  }

  List<Widget> _buildClassifyCommentSlivers(BuildContext context) {
    if (_classifyList.isEmpty) {
      return [_buildEmptyStateSliver(context, '暂无分类', CupertinoIcons.tag)];
    }

    return [
      SliverToBoxAdapter(child: _buildClassifySelector()),
      if (_classifyComments.isEmpty && !_isFetchingClassify)
        _buildEmptyStateSliver(
          context,
          '该分类下暂无评论',
          CupertinoIcons.chat_bubble_text,
        )
      else
        SliverPadding(
          padding: const EdgeInsets.fromLTRB(24, 12, 24, 40),
          sliver: SliverList(
            delegate: SliverChildBuilderDelegate((context, index) {
              if (index < _classifyComments.length) {
                return _buildCommentItem(
                  context,
                  _classifyComments[index] as Map,
                );
              }
              return _buildLoadingIndicator(_hasMoreClassify);
            }, childCount: _classifyComments.length + 1),
          ),
        ),
    ];
  }

  List<Widget> _buildHotwordCommentSlivers(BuildContext context) {
    if (_hotWordList.isEmpty) {
      return [_buildEmptyStateSliver(context, '暂无热词', CupertinoIcons.flame)];
    }

    return [
      SliverToBoxAdapter(child: _buildHotwordSelector()),
      if (_hotwordComments.isEmpty && !_isFetchingHotword)
        _buildEmptyStateSliver(
          context,
          '该热词下暂无评论',
          CupertinoIcons.chat_bubble_text,
        )
      else
        SliverPadding(
          padding: const EdgeInsets.fromLTRB(24, 12, 24, 40),
          sliver: SliverList(
            delegate: SliverChildBuilderDelegate((context, index) {
              if (index < _hotwordComments.length) {
                return _buildCommentItem(
                  context,
                  _hotwordComments[index] as Map,
                );
              }
              return _buildLoadingIndicator(_hasMoreHotword);
            }, childCount: _hotwordComments.length + 1),
          ),
        ),
    ];
  }

  Widget _buildEmptyStateSliver(
    BuildContext context,
    String msg,
    IconData icon,
  ) {
    return SliverFillRemaining(
      hasScrollBody: false,
      child: _buildEmptyState(context, msg, icon),
    );
  }

  String _getFavoriteCount() {
    try {
      final favList = _favoriteData?['data']?['list'] as List?;
      if (favList != null && favList.isNotEmpty) {
        return favList[0]['count_text']?.toString() ??
            favList[0]['count']?.toString() ??
            '0';
      }
    } catch (_) {}
    return '--';
  }

  String _getCommentCount() {
    try {
      final headerCount = _resolveCommentCountFromHeaderStats();
      if (headerCount != null) {
        return _formatCountWithW(headerCount);
      }
      final payload = _commentsData?['data'] is Map<String, dynamic>
          ? _commentsData!['data'] as Map<String, dynamic>
          : _commentsData;
      if (payload != null && payload['count'] != null) {
        return _formatCountWithW(payload['count']);
      }
    } catch (_) {}
    return '--';
  }

  dynamic _resolveCommentCountFromHeaderStats() {
    final data = _commentCountData;
    if (data == null || data.isEmpty) return null;

    final exact = data[widget.song.hash];
    if (exact != null) return exact;

    final lowerHash = widget.song.hash.toLowerCase();
    final lower = data[lowerHash];
    if (lower != null) return lower;

    for (final entry in data.entries) {
      if (entry.key.toLowerCase() == lowerHash) {
        return entry.value;
      }
    }

    return null;
  }

  String _formatCountWithW(dynamic value) {
    if (value == null) return '--';
    final count = value is int ? value : int.tryParse(value.toString());
    if (count == null) return value.toString();
    if (count < 10000) return count.toString();
    final formatted = (count / 10000).toStringAsFixed(count >= 100000 ? 0 : 1);
    return '${formatted.endsWith('.0') ? formatted.substring(0, formatted.length - 2) : formatted}w';
  }

  Widget _buildQualitySection(BuildContext context) {
    final List relateGoods = _privilegeData?['relate_goods'] ?? [];
    if (relateGoods.isEmpty) return const SizedBox.shrink();

    final uniqueItems = _dedupeRelateGoods(relateGoods);
    final qualityItems = uniqueItems
        .where((item) {
          final q = item['quality']?.toString() ?? '';
          return q.isNotEmpty && !_isAudioEffect(q);
        })
        .toList(growable: false);
    final effectItems = uniqueItems
        .where((item) {
          final q = item['quality']?.toString() ?? '';
          return q.isNotEmpty && _isAudioEffect(q);
        })
        .toList(growable: false);

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
        if (qualityItems.isNotEmpty && effectItems.isNotEmpty)
          const SizedBox(height: 24),
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
      final quality = map['quality']?.toString() ?? '';
      if (quality.isEmpty || seen.contains(quality)) continue;
      seen.add(quality);
      result.add(map);
    }

    return result;
  }

  Widget _buildQualityTags(BuildContext context, List items) {
    final theme = Theme.of(context);
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: items
          .map((item) {
            final quality = item['quality']?.toString() ?? '';
            return Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              decoration: BoxDecoration(
                color: theme.colorScheme.primary.withAlpha(10),
                borderRadius: BorderRadius.circular(8),
                border: Border.all(
                  color: theme.colorScheme.primary.withAlpha(20),
                ),
              ),
              child: Text(
                _getQualityLabel(quality),
                style: TextStyle(
                  fontSize: 11,
                  fontWeight: FontWeight.w700,
                  color: theme.colorScheme.primary,
                ),
              ),
            );
          })
          .toList(growable: false),
    );
  }

  bool _isAudioEffect(String quality) {
    return quality != AudioEffect.none.value &&
        AudioEffect.options.any((effect) => effect.value == quality);
  }

  String _getQualityLabel(String quality) {
    if (_isAudioEffect(quality)) {
      return AudioEffect.getLabel(quality);
    }
    return AudioQuality.getLabelOrRaw(quality);
  }

  Widget _buildRankingsSection(BuildContext context) {
    final rankingInfo = _rankingData?['data']?['info'] is List
        ? _rankingData!['data']!['info'] as List<dynamic>
        : <dynamic>[];
    final String? summary = _rankingData?['data']?['title2']?.toString();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            const Icon(CupertinoIcons.gift_fill, size: 20, color: Colors.amber),
            const SizedBox(width: 8),
            const Text(
              '榜单成就',
              style: TextStyle(fontSize: 18, fontWeight: FontWeight.w900),
            ),
            if (summary != null && summary.isNotEmpty) ...[
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  '• $summary',
                  style: TextStyle(
                    fontSize: 12,
                    color: Theme.of(context).disabledColor,
                    fontWeight: FontWeight.w500,
                  ),
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
            itemBuilder: (context, index) =>
                _buildRankCard(context, rankingInfo[index] as Map),
          ),
      ],
    );
  }

  Widget _buildRankCard(BuildContext context, Map rank) {
    final theme = Theme.of(context);
    final lastTime = rank['last_time']?.toString() ?? '未知';
    final currentRank = rank['ranking_num'] ?? 0;
    final rankingTimes = rank['ranking_times'] ?? 0;

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
              letterSpacing: -1,
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
            fontWeight: FontWeight.w600,
          ),
        ),
        Text(
          value,
          style: TextStyle(
            fontSize: 12,
            color: theme.colorScheme.onSurface,
            fontWeight: FontWeight.w800,
          ),
        ),
      ],
    );
  }

  Widget _buildEmptyRankings(BuildContext context) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(40),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.onSurface.withAlpha(5),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Center(
        child: Column(
          children: [
            Icon(
              CupertinoIcons.gift,
              size: 40,
              color: Theme.of(context).disabledColor.withAlpha(50),
            ),
            const SizedBox(height: 12),
            Text(
              '暂无榜单数据',
              style: TextStyle(
                color: Theme.of(context).disabledColor,
                fontSize: 14,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildClassifySelector() {
    final theme = Theme.of(context);
    return Container(
      height: 52,
      margin: const EdgeInsets.only(top: 8, bottom: 4),
      child: ListView.builder(
        controller: _classifyHeaderScrollController,
        scrollDirection: Axis.horizontal,
        physics: const BouncingScrollPhysics(),
        padding: const EdgeInsets.symmetric(horizontal: 24),
        itemCount: _classifyList.length,
        itemBuilder: (context, index) {
          final item = _classifyList[index] as Map;
          final isSelected = _selectedClassifyId == item['id'];
          return Padding(
            padding: const EdgeInsets.only(right: 10),
            child: ChoiceChip(
              label: Text('${item['label']} ${item['cnt'] ?? ''}'),
              selected: isSelected,
              onSelected: (selected) {
                if (!selected) return;
                setState(() => _selectedClassifyId = item['id'] as int?);
                _fetchClassifyComments(isRefresh: true);
                _scrollToIndex(_classifyHeaderScrollController, index);
              },
              selectedColor: theme.colorScheme.primary,
              labelStyle: TextStyle(
                color: isSelected
                    ? Colors.white
                    : theme.colorScheme.onSurface.withAlpha(180),
                fontSize: 12,
                fontWeight: isSelected ? FontWeight.w900 : FontWeight.w600,
              ),
              backgroundColor: theme.colorScheme.onSurface.withAlpha(10),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(14),
              ),
              side: BorderSide.none,
              showCheckmark: false,
              elevation: isSelected ? 4 : 0,
              pressElevation: 0,
            ),
          );
        },
      ),
    );
  }

  Widget _buildHotwordSelector() {
    final theme = Theme.of(context);
    return Container(
      height: 52,
      margin: const EdgeInsets.only(top: 8, bottom: 4),
      child: ListView.builder(
        controller: _hotwordHeaderScrollController,
        scrollDirection: Axis.horizontal,
        physics: const BouncingScrollPhysics(),
        padding: const EdgeInsets.symmetric(horizontal: 24),
        itemCount: _hotWordList.length,
        itemBuilder: (context, index) {
          final item = _hotWordList[index] as Map;
          final isSelected = _selectedHotWord == item['content'];
          return Padding(
            padding: const EdgeInsets.only(right: 10),
            child: ChoiceChip(
              label: Text('${item['content']} ${item['count'] ?? ''}'),
              selected: isSelected,
              onSelected: (selected) {
                if (!selected) return;
                setState(() => _selectedHotWord = item['content']?.toString());
                _fetchHotwordComments(isRefresh: true);
                _scrollToIndex(_hotwordHeaderScrollController, index);
              },
              selectedColor: theme.colorScheme.primary,
              labelStyle: TextStyle(
                color: isSelected
                    ? Colors.white
                    : theme.colorScheme.onSurface.withAlpha(180),
                fontSize: 12,
                fontWeight: isSelected ? FontWeight.w900 : FontWeight.w600,
              ),
              backgroundColor: theme.colorScheme.onSurface.withAlpha(10),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(14),
              ),
              side: BorderSide.none,
              showCheckmark: false,
              elevation: isSelected ? 4 : 0,
              pressElevation: 0,
            ),
          );
        },
      ),
    );
  }

  void _scrollToIndex(ScrollController controller, int index) {
    if (!controller.hasClients) return;
    double offset = index * 100.0;
    if (offset > controller.position.maxScrollExtent) {
      offset = controller.position.maxScrollExtent;
    }
    controller.animateTo(
      offset,
      duration: const Duration(milliseconds: 300),
      curve: Curves.easeInOutCubic,
    );
  }

  int _calculateHotItemCount(List<dynamic> starList) {
    int count = _hotComments.length;
    if (starList.isNotEmpty) {
      count += starList.length + 2;
    }
    if (_hotComments.isNotEmpty) {
      count += 1;
    }
    return count;
  }

  Widget _buildHotCommentItem(
    BuildContext context,
    int index,
    List<dynamic> starList,
  ) {
    int offset = 0;
    if (starList.isNotEmpty) {
      if (index == 0) return _buildSectionHeader('歌手说');
      if (index <= starList.length) {
        return _buildCommentItem(
          context,
          starList[index - 1] as Map,
          isStar: true,
        );
      }
      offset = starList.length + 1;
      if (index == offset) return const SizedBox(height: 24);
      offset++;
    }
    if (index == offset) return _buildSectionHeader('热门评论');
    final commentIndex = index - offset - 1;
    if (commentIndex >= 0 && commentIndex < _hotComments.length) {
      return _buildCommentItem(context, _hotComments[commentIndex] as Map);
    }
    return const SizedBox.shrink();
  }

  Widget _buildCommentItem(
    BuildContext context,
    Map comment, {
    bool isStar = false,
  }) {
    final theme = Theme.of(context);
    final likeCount = comment['like']?['count'] ?? 0;
    return Container(
      margin: const EdgeInsets.only(bottom: 16),
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: isStar
            ? theme.colorScheme.primary.withAlpha(10)
            : theme.colorScheme.onSurface.withAlpha(5),
        borderRadius: BorderRadius.circular(20),
        border: isStar
            ? Border.all(color: theme.colorScheme.primary.withAlpha(20))
            : null,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(18),
                child: Image.network(
                  comment['user_pic'] ?? '',
                  width: 36,
                  height: 36,
                  errorBuilder: (context, error, stackTrace) =>
                      const Icon(CupertinoIcons.person_alt_circle, size: 36),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Text(
                          comment['user_name'] ?? '匿名用户',
                          style: const TextStyle(
                            fontSize: 14,
                            fontWeight: FontWeight.w800,
                          ),
                        ),
                        if (isStar)
                          Container(
                            margin: const EdgeInsets.only(left: 8),
                            padding: const EdgeInsets.symmetric(
                              horizontal: 6,
                              vertical: 2,
                            ),
                            decoration: BoxDecoration(
                              color: theme.colorScheme.primary,
                              borderRadius: BorderRadius.circular(6),
                            ),
                            child: const Text(
                              '歌手',
                              style: TextStyle(
                                fontSize: 9,
                                color: Colors.white,
                                fontWeight: FontWeight.bold,
                              ),
                            ),
                          ),
                      ],
                    ),
                    const SizedBox(height: 2),
                    Text(
                      comment['addtime']?.toString() ?? '',
                      style: TextStyle(
                        fontSize: 10,
                        color: theme.colorScheme.onSurface.withAlpha(100),
                      ),
                    ),
                  ],
                ),
              ),
              _buildLikeBadge(context, likeCount as int),
            ],
          ),
          const SizedBox(height: 12),
          Text(
            comment['content'] ?? '',
            style: const TextStyle(
              fontSize: 14,
              height: 1.5,
              fontWeight: FontWeight.w500,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildSectionHeader(String title) {
    return Padding(
      padding: const EdgeInsets.only(left: 4, bottom: 12, top: 8),
      child: Text(
        title,
        style: const TextStyle(
          fontSize: 12,
          fontWeight: FontWeight.w900,
          color: Colors.grey,
          letterSpacing: 1,
        ),
      ),
    );
  }

  Widget _buildLikeBadge(BuildContext context, int count) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: theme.colorScheme.surface,
        borderRadius: BorderRadius.circular(16),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withAlpha(5),
            blurRadius: 10,
            offset: const Offset(0, 2),
          ),
        ],
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(
            CupertinoIcons.hand_thumbsup_fill,
            size: 12,
            color: theme.colorScheme.primary,
          ),
          const SizedBox(width: 6),
          Text(
            _formatBigNumber(count),
            style: TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w900,
              color: theme.colorScheme.primary,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildLoadingIndicator(bool hasMore) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 20),
      child: Center(
        child: hasMore
            ? const CupertinoActivityIndicator()
            : Text(
                '已加载全部评论',
                style: TextStyle(
                  color: Theme.of(context).disabledColor,
                  fontSize: 12,
                ),
              ),
      ),
    );
  }

  Widget _buildEmptyState(BuildContext context, String msg, IconData icon) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(
            icon,
            size: 50,
            color: Theme.of(context).disabledColor.withAlpha(30),
          ),
          const SizedBox(height: 12),
          Text(
            msg,
            style: TextStyle(
              color: Theme.of(context).disabledColor,
              fontSize: 14,
            ),
          ),
        ],
      ),
    );
  }

  String _formatBigNumber(int number) {
    if (number < 10000) return number.toString();
    return '${(number / 10000).toStringAsFixed(1)}w';
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
        Text(
          label,
          style: TextStyle(
            fontSize: 12,
            color: theme.colorScheme.onSurface.withAlpha(100),
            fontWeight: FontWeight.w600,
          ),
        ),
        const SizedBox(height: 4),
        Text(
          value,
          style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w800),
        ),
      ],
    );
  }
}

class _FixedHeaderDelegate extends SliverPersistentHeaderDelegate {
  _FixedHeaderDelegate({required this.height, required this.child});

  final double height;
  final Widget child;

  @override
  double get minExtent => height;

  @override
  double get maxExtent => height;

  @override
  Widget build(
    BuildContext context,
    double shrinkOffset,
    bool overlapsContent,
  ) {
    return child;
  }

  @override
  bool shouldRebuild(covariant _FixedHeaderDelegate oldDelegate) {
    return height != oldDelegate.height || child != oldDelegate.child;
  }
}
