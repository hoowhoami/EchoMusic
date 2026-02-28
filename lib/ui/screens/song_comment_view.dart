import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import '../../models/song.dart';
import '../../api/music_api.dart';
import '../widgets/custom_tab_bar.dart';
import '../widgets/cover_image.dart';

class SongCommentView extends StatefulWidget {
  final Song song;

  const SongCommentView({super.key, required this.song});

  @override
  State<SongCommentView> createState() => _SongCommentViewState();
}

class _SongCommentViewState extends State<SongCommentView> with TickerProviderStateMixin {
  bool _isLoading = true;
  bool _isFetchingMore = false;
  bool _hasMore = true;
  int _currentPage = 1;
  final int _pageSize = 30;

  Map<String, dynamic>? _commentsData;
  Map<String, dynamic>? _commentCountData;
  final List<dynamic> _allComments = [];
  List<dynamic> _hotComments = [];
  
  late TabController _tabController;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 2, vsync: this);
    _fetchComments(isRefresh: true);
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  Future<void> _fetchComments({bool isRefresh = false}) async {
    if (_isFetchingMore) return;

    if (isRefresh) {
      setState(() {
        _isLoading = true;
        _currentPage = 1;
        _allComments.clear();
        _hotComments.clear();
      });
    } else {
      setState(() => _isFetchingMore = true);
    }

    try {
      final results = await Future.wait([
        MusicApi.getMusicComments(widget.song.mixSongId, page: _currentPage, pagesize: _pageSize),
        if (isRefresh) MusicApi.getCommentCount(widget.song.hash) else Future.value(null),
      ]);
      
      final Map<String, dynamic> currentCommentsData = results[0] as Map<String, dynamic>;
      final List newComments = currentCommentsData['list'] is List ? currentCommentsData['list'] : [];

      if (mounted) {
        setState(() {
          _commentsData = currentCommentsData;
          if (isRefresh) {
            if (results[1] != null) {
              _commentCountData = results[1] as Map<String, dynamic>;
            }
            // 修正热门评论逻辑：如果接口没有显式的 weight_list，则取第一页的前 30 条作为热门
            _hotComments = currentCommentsData['weight_list'] is List 
                ? currentCommentsData['weight_list'] 
                : newComments.take(30).toList();
          }
          
          _allComments.addAll(newComments);
          _hasMore = newComments.length >= _pageSize;
          if (_hasMore) _currentPage++;
          
          _isLoading = false;
          _isFetchingMore = false;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _isLoading = false;
          _isFetchingMore = false;
        });
      }
    }
  }

  String _getCommentCount() {
    try {
      final String hashKey = widget.song.hash.toLowerCase();
      if (_commentCountData != null && _commentCountData![hashKey] != null) {
        return _commentCountData![hashKey].toString();
      }
      if (_commentsData != null && _commentsData!['count'] != null) {
        return _commentsData!['count'].toString();
      }
    } catch (_) {}
    return '0';
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final commentCount = _getCommentCount();

    if (_isLoading) {
      return Scaffold(
        backgroundColor: theme.scaffoldBackgroundColor,
        body: const Center(child: CupertinoActivityIndicator()),
      );
    }

    return Scaffold(
      backgroundColor: theme.scaffoldBackgroundColor,
      body: NestedScrollView(
        headerSliverBuilder: (context, innerBoxIsScrolled) {
          return [
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
                            Padding(
                              padding: const EdgeInsets.only(right: 24),
                              child: Text(
                                commentCount,
                                style: TextStyle(
                                  color: theme.colorScheme.primary,
                                  fontSize: 14,
                                  fontWeight: FontWeight.w900,
                                  fontFamily: 'monospace',
                                ),
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
                              'COMMENTS',
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
                      const SizedBox(width: 24),
                      Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        crossAxisAlignment: CrossAxisAlignment.end,
                        children: [
                          Text(
                            '评论总数',
                            style: TextStyle(
                              fontSize: 12,
                              color: theme.colorScheme.onSurface.withAlpha(100),
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                          const SizedBox(height: 4),
                          Text(
                            commentCount,
                            style: const TextStyle(
                              fontSize: 20,
                              fontWeight: FontWeight.w900,
                              fontFamily: 'monospace',
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
            ),
            SliverPersistentHeader(
              pinned: true,
              delegate: _SliverTabHeaderDelegate(
                child: Container(
                  color: theme.scaffoldBackgroundColor,
                  padding: const EdgeInsets.fromLTRB(24, 8, 24, 8),
                  child: CustomTabBar(
                    controller: _tabController,
                    tabs: const ['精彩评论', '全部评论'],
                  ),
                ),
              ),
            ),
          ];
        },
        body: TabBarView(
          controller: _tabController,
          children: [
            _buildCommentList(isHot: true),
            _buildCommentList(isHot: false),
          ],
        ),
      ),
    );
  }

  Widget _buildCommentList({required bool isHot}) {
    List displayList = isHot ? _hotComments : _allComments;
    List? starList = (_commentsData?['star_cmts']?['list'] is List) ? _commentsData!['star_cmts']!['list'] : [];

    if (displayList.isEmpty && (starList == null || starList.isEmpty)) {
      return _buildEmptyState(context, '暂无评论', CupertinoIcons.chat_bubble_text);
    }

    return NotificationListener<ScrollNotification>(
      onNotification: (ScrollNotification notification) {
        // 仅在“全部评论”页签且滚动到底部时触发加载
        if (!isHot && 
            notification is ScrollUpdateNotification && 
            notification.metrics.pixels >= notification.metrics.maxScrollExtent - 200) {
          if (!_isFetchingMore && _hasMore) {
            _fetchComments();
          }
        }
        return false;
      },
      child: ScrollConfiguration(
        behavior: ScrollConfiguration.of(context).copyWith(scrollbars: false),
        child: ListView.builder(
          padding: const EdgeInsets.fromLTRB(24, 12, 24, 40),
          // 虚拟列表核心：使用 builder 只渲染可见项
          itemCount: _calculateItemCount(isHot, displayList, starList),
          itemBuilder: (context, index) => _buildItem(context, index, isHot, displayList, starList),
        ),
      ),
    );
  }

  int _calculateItemCount(bool isHot, List displayList, List? starList) {
    if (isHot) {
      int count = displayList.length;
      if (starList != null && starList.isNotEmpty) count += (starList.length + 2); // 标题 + 列表 + 间距
      if (displayList.isNotEmpty) count += 1; // 热门标题
      return count;
    } else {
      return displayList.length + 1; // 列表 + 加载更多提示
    }
  }

  Widget _buildItem(BuildContext context, int index, bool isHot, List displayList, List? starList) {
    int offset = 0;

    if (isHot) {
      // 1. 歌手说部分
      if (starList != null && starList.isNotEmpty) {
        if (index == 0) return _buildSectionHeader('歌手说');
        if (index <= starList.length) return _buildCommentItem(context, starList[index - 1], isStar: true);
        offset = starList.length + 1;
        if (index == offset) return const SizedBox(height: 24);
        offset++;
      }

      // 2. 热门评论标题
      if (index == offset) return _buildSectionHeader('热门评论');
      int cmtIndex = index - offset - 1;

      // 3. 热门评论项
      if (cmtIndex >= 0 && cmtIndex < displayList.length) {
        return _buildCommentItem(context, displayList[cmtIndex]);
      }
    } else {
      // 全部评论逻辑
      if (index < displayList.length) {
        return _buildCommentItem(context, displayList[index]);
      }
      // 加载状态
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 20),
        child: Center(
          child: _hasMore 
              ? const CupertinoActivityIndicator() 
              : Text('已加载全部评论', style: TextStyle(color: Theme.of(context).disabledColor, fontSize: 12)),
        ),
      );
    }
    return const SizedBox.shrink();
  }

  Widget _buildCommentItem(BuildContext context, Map comment, {bool isStar = false}) {
    final theme = Theme.of(context);
    final likeCount = comment['like']?['count'] ?? 0;
    
    return Container(
      margin: const EdgeInsets.only(bottom: 16),
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: isStar ? theme.colorScheme.primary.withAlpha(10) : theme.colorScheme.onSurface.withAlpha(5),
        borderRadius: BorderRadius.circular(20),
        border: isStar ? Border.all(color: theme.colorScheme.primary.withAlpha(20)) : null,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(18),
                child: Image.network(comment['user_pic'] ?? '', width: 36, height: 36, errorBuilder: (_,__,___) => const Icon(CupertinoIcons.person_alt_circle, size: 36)),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Text(comment['user_name'] ?? '匿名用户', style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w800)),
                        if (isStar)
                          Container(
                            margin: const EdgeInsets.only(left: 8),
                            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                            decoration: BoxDecoration(color: theme.colorScheme.primary, borderRadius: BorderRadius.circular(6)),
                            child: const Text('歌手', style: TextStyle(fontSize: 9, color: Colors.white, fontWeight: FontWeight.bold)),
                          ),
                      ],
                    ),
                    const SizedBox(height: 2),
                    Text(comment['addtime']?.toString() ?? '', style: TextStyle(fontSize: 10, color: theme.colorScheme.onSurface.withAlpha(100))),
                  ],
                ),
              ),
              _buildLikeBadge(context, likeCount),
            ],
          ),
          const SizedBox(height: 12),
          Text(comment['content'] ?? '', style: const TextStyle(fontSize: 14, height: 1.5, fontWeight: FontWeight.w500)),
        ],
      ),
    );
  }

  Widget _buildSectionHeader(String title) {
    return Padding(
      padding: const EdgeInsets.only(left: 4, bottom: 12, top: 8),
      child: Text(title, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w900, color: Colors.grey, letterSpacing: 1.0)),
    );
  }

  Widget _buildLikeBadge(BuildContext context, int count) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: theme.colorScheme.surface,
        borderRadius: BorderRadius.circular(16),
        boxShadow: [BoxShadow(color: Colors.black.withAlpha(5), blurRadius: 10, offset: const Offset(0, 2))],
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(CupertinoIcons.hand_thumbsup_fill, size: 12, color: theme.colorScheme.primary),
          const SizedBox(width: 6),
          Text(_formatBigNumber(count), style: TextStyle(fontSize: 11, fontWeight: FontWeight.w900, color: theme.colorScheme.primary)),
        ],
      ),
    );
  }

  Widget _buildEmptyState(BuildContext context, String msg, IconData icon) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(icon, size: 50, color: Theme.of(context).disabledColor.withAlpha(30)),
          const SizedBox(height: 12),
          Text(msg, style: TextStyle(color: Theme.of(context).disabledColor, fontSize: 14)),
        ],
      ),
    );
  }

  String _formatBigNumber(int number) {
    if (number < 10000) return number.toString();
    return '${(number / 10000).toStringAsFixed(1)}w';
  }
}

class _SliverTabHeaderDelegate extends SliverPersistentHeaderDelegate {
  final Widget child;
  _SliverTabHeaderDelegate({required this.child});

  @override
  double get minExtent => 58;
  @override
  double get maxExtent => 58;

  @override
  Widget build(BuildContext context, double shrinkOffset, bool overlapsContent) {
    return child;
  }

  @override
  bool shouldRebuild(_SliverTabHeaderDelegate oldDelegate) {
    return false;
  }
}
