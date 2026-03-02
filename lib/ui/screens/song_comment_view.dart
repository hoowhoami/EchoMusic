import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import '../../models/song.dart';
import '../../api/music_api.dart';
import '../widgets/custom_tab_bar.dart';
import '../widgets/cover_image.dart';
import '../widgets/back_to_top.dart';

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

  late TabController _tabController;
  final ScrollController _mainScrollController = ScrollController();
  
  final ScrollController _classifyHeaderScrollController = ScrollController();
  final ScrollController _hotwordHeaderScrollController = ScrollController();

  // 用于手动控制回到顶部按钮的显隐
  bool _showBackToTop = false;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 4, vsync: this);
    _tabController.addListener(_handleTabChange);
    _fetchComments(isRefresh: true);
  }

  void _handleTabChange() {
    if (_tabController.indexIsChanging) return;
    
    if (_tabController.index == 2 && _classifyComments.isEmpty && _classifyList.isNotEmpty) {
      _selectedClassifyId = _classifyList[0]['id'];
      _fetchClassifyComments(isRefresh: true);
    } else if (_tabController.index == 3 && _hotwordComments.isEmpty && _hotWordList.isNotEmpty) {
      _selectedHotWord = _hotWordList[0]['content'];
      _fetchHotwordComments(isRefresh: true);
    }
  }

  @override
  void dispose() {
    _tabController.removeListener(_handleTabChange);
    _tabController.dispose();
    _mainScrollController.dispose();
    _classifyHeaderScrollController.dispose();
    _hotwordHeaderScrollController.dispose();
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
        MusicApi.getMusicComments(
          widget.song.mixSongId, 
          page: _currentPage, 
          pagesize: _pageSize,
          showClassify: isRefresh,
          showHotwordList: isRefresh,
        ),
        if (isRefresh) MusicApi.getCommentCount(widget.song.hash) else Future.value(null),
      ]);
      final Map<String, dynamic> data = results[0] as Map<String, dynamic>;
      final Map<String, dynamic> payload = data['data'] is Map ? data['data'] : data;
      final List newComments = payload['list'] is List ? payload['list'] : [];
      if (mounted) {
        setState(() {
          _commentsData = data;
          if (isRefresh) {
            if (results[1] != null) _commentCountData = results[1] as Map<String, dynamic>;
            _hotComments = payload['weight_list'] is List ? payload['weight_list'] : newComments.take(30).toList();
            _classifyList = payload['classify_list'] is List ? payload['classify_list'] : [];
            _hotWordList = payload['hot_word_list'] is List ? payload['hot_word_list'] : [];
          }
          _allComments.addAll(newComments);
          int total = payload['count'] ?? payload['total'] ?? 0;
          if (total > 0) _hasMore = _allComments.length < total;
          else _hasMore = newComments.length >= _pageSize;
          if (_hasMore) _currentPage++;
          _isLoading = false;
          _isFetchingMore = false;
        });
      }
    } catch (e) {
      if (mounted) setState(() { _isLoading = false; _isFetchingMore = false; });
    }
  }

  Future<void> _fetchClassifyComments({bool isRefresh = false}) async {
    if (_isFetchingClassify || _selectedClassifyId == null) return;
    if (isRefresh) setState(() { _classifyPage = 1; _classifyComments.clear(); _hasMoreClassify = true; });
    setState(() => _isFetchingClassify = true);
    try {
      final data = await MusicApi.getMusicClassifyComments(widget.song.mixSongId, _selectedClassifyId!, page: _classifyPage, pagesize: _pageSize);
      final Map<String, dynamic> payload = data['data'] is Map ? data['data'] : data;
      final List newComments = payload['list'] is List ? payload['list'] : [];
      if (mounted) {
        setState(() {
          _classifyComments.addAll(newComments);
          final selectedItem = _classifyList.firstWhere((item) => item['id'] == _selectedClassifyId, orElse: () => null);
          int total = payload['count'] ?? payload['total'] ?? (selectedItem != null ? selectedItem['cnt'] : 0);
          if (total > 0) _hasMoreClassify = _classifyComments.length < total;
          else _hasMoreClassify = newComments.length >= _pageSize;
          if (_hasMoreClassify) _classifyPage++;
          _isFetchingClassify = false;
        });
      }
    } catch (e) {
      if (mounted) setState(() => _isFetchingClassify = false);
    }
  }

  Future<void> _fetchHotwordComments({bool isRefresh = false}) async {
    if (_isFetchingHotword || _selectedHotWord == null) return;
    if (isRefresh) setState(() { _hotwordPage = 1; _hotwordComments.clear(); _hasMoreHotword = true; });
    setState(() => _isFetchingHotword = true);
    try {
      final data = await MusicApi.getMusicHotwordComments(widget.song.mixSongId, _selectedHotWord!, page: _hotwordPage, pagesize: _pageSize);
      final Map<String, dynamic> payload = data['data'] is Map ? data['data'] : data;
      final List newComments = payload['list'] is List ? payload['list'] : [];
      if (mounted) {
        setState(() {
          _hotwordComments.addAll(newComments);
          final selectedItem = _hotWordList.firstWhere((item) => item['content'] == _selectedHotWord, orElse: () => null);
          int total = payload['count'] ?? payload['total'] ?? (selectedItem != null ? selectedItem['count'] : 0);
          if (total > 0) _hasMoreHotword = _hotwordComments.length < total;
          else _hasMoreHotword = newComments.length >= _pageSize;
          if (_hasMoreHotword) _hotwordPage++;
          _isFetchingHotword = false;
        });
      }
    } catch (e) {
      if (mounted) setState(() => _isFetchingHotword = false);
    }
  }

  String _getCommentCount() {
    try {
      final String hashKey = widget.song.hash.toLowerCase();
      if (_commentCountData != null && _commentCountData![hashKey] != null) return _commentCountData![hashKey].toString();
      final Map<String, dynamic>? payload = _commentsData?['data'] is Map ? _commentsData!['data'] : _commentsData;
      if (payload != null && payload['count'] != null) return payload['count'].toString();
    } catch (_) {}
    return '0';
  }

  void _scrollToTop() {
    _mainScrollController.animateTo(
      0,
      duration: const Duration(milliseconds: 500),
      curve: Curves.easeInOutCubic,
    );
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
      body: Stack(
        children: [
          NotificationListener<ScrollNotification>(
            onNotification: (notification) {
              if (notification.metrics.axis == Axis.vertical) {
                // 根据累积滚动偏移量判断显隐
                if (notification.metrics.pixels > 300 && !_showBackToTop) {
                  setState(() => _showBackToTop = true);
                } else if (notification.metrics.pixels <= 300 && _showBackToTop) {
                  setState(() => _showBackToTop = false);
                }
              }
              return false;
            },
            child: NestedScrollView(
              controller: _mainScrollController,
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
                                  CoverImage(url: widget.song.cover, width: 32, height: 32, borderRadius: 6, showShadow: false),
                                  const SizedBox(width: 12),
                                  Expanded(child: Text(widget.song.name, style: TextStyle(color: theme.colorScheme.onSurface, fontSize: 16, fontWeight: FontWeight.w900), maxLines: 1, overflow: TextOverflow.ellipsis)),
                                  Padding(padding: const EdgeInsets.only(right: 24), child: Text(commentCount, style: TextStyle(color: theme.colorScheme.primary, fontSize: 14, fontWeight: FontWeight.w900, fontFamily: 'monospace'))),
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
                            CoverImage(url: widget.song.cover, width: 130, height: 130, borderRadius: 16, showShadow: true),
                            const SizedBox(width: 24),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                mainAxisAlignment: MainAxisAlignment.center,
                                children: [
                                  Text('COMMENTS', style: TextStyle(color: theme.colorScheme.primary, fontSize: 10, fontWeight: FontWeight.w900, letterSpacing: 2.0)),
                                  const SizedBox(height: 4),
                                  Text(widget.song.name, style: theme.textTheme.titleLarge?.copyWith(fontSize: 22, fontWeight: FontWeight.w900, height: 1.1), maxLines: 1, overflow: TextOverflow.ellipsis),
                                  const SizedBox(height: 8),
                                  Text(widget.song.singerName, style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700, color: theme.colorScheme.primary), maxLines: 1, overflow: TextOverflow.ellipsis),
                                ],
                              ),
                            ),
                            const SizedBox(width: 24),
                            Column(
                              mainAxisAlignment: MainAxisAlignment.center,
                              crossAxisAlignment: CrossAxisAlignment.end,
                              children: [
                                Text('评论总数', style: TextStyle(fontSize: 12, color: theme.colorScheme.onSurface.withAlpha(100), fontWeight: FontWeight.w600)),
                                const SizedBox(height: 4),
                                Text(commentCount, style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w900, fontFamily: 'monospace')),
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
                          tabs: const ['精彩评论', '全部评论', '分类评论', '热词评论'],
                        ),
                      ),
                    ),
                  ),
                ];
              },
              body: TabBarView(
                controller: _tabController,
                children: [
                  _buildCommentList(type: 'hot'),
                  _buildCommentList(type: 'all'),
                  _buildClassifyCommentList(),
                  _buildHotwordCommentList(),
                ],
              ),
            ),
          ),
          BackToTop(
            show: _showBackToTop,
            onPressed: _scrollToTop,
          ),
        ],
      ),
    );
  }

  Widget _buildCommentList({required String type}) {
    List displayList = type == 'hot' ? _hotComments : _allComments;
    final Map<String, dynamic>? payload = _commentsData?['data'] is Map ? _commentsData!['data'] : _commentsData;
    List? starList = (payload?['star_cmts']?['list'] is List) ? payload!['star_cmts']!['list'] : [];

    if (displayList.isEmpty && (starList == null || starList.isEmpty)) return _buildEmptyState(context, '暂无评论', CupertinoIcons.chat_bubble_text);

    return NotificationListener<ScrollNotification>(
      onNotification: (ScrollNotification notification) {
        if (type == 'all' && notification.metrics.axis == Axis.vertical && notification is ScrollUpdateNotification && notification.metrics.pixels >= notification.metrics.maxScrollExtent - 400) {
          if (!_isFetchingMore && _hasMore) _fetchComments();
        }
        return false;
      },
      child: ScrollConfiguration(
        behavior: ScrollConfiguration.of(context).copyWith(scrollbars: false),
        child: ListView.builder(
          padding: const EdgeInsets.fromLTRB(24, 12, 24, 40),
          itemCount: _calculateItemCount(type, displayList, starList),
          itemBuilder: (context, index) => _buildItem(context, index, type, displayList, starList),
        ),
      ),
    );
  }

  Widget _buildClassifyCommentList() {
    if (_classifyList.isEmpty) return _buildEmptyState(context, '暂无分类', CupertinoIcons.tag);
    return Column(
      children: [
        _buildClassifySelector(),
        Expanded(
          child: NotificationListener<ScrollNotification>(
            onNotification: (ScrollNotification notification) {
              if (notification.metrics.axis == Axis.vertical && notification is ScrollUpdateNotification && notification.metrics.pixels >= notification.metrics.maxScrollExtent - 400) {
                if (!_isFetchingClassify && _hasMoreClassify) _fetchClassifyComments();
              }
              return false;
            },
            child: _classifyComments.isEmpty && !_isFetchingClassify
                ? _buildEmptyState(context, '该分类下暂无评论', CupertinoIcons.chat_bubble_text)
                : ScrollConfiguration(
                    behavior: ScrollConfiguration.of(context).copyWith(scrollbars: false),
                    child: ListView.builder(
                      padding: const EdgeInsets.fromLTRB(24, 12, 24, 40),
                      itemCount: _classifyComments.length + 1,
                      itemBuilder: (context, index) {
                        if (index < _classifyComments.length) return _buildCommentItem(context, _classifyComments[index]);
                        return _buildLoadingIndicator(_hasMoreClassify);
                      },
                    ),
                  ),
          ),
        ),
      ],
    );
  }

  Widget _buildHotwordCommentList() {
    if (_hotWordList.isEmpty) return _buildEmptyState(context, '暂无热词', CupertinoIcons.flame);
    return Column(
      children: [
        _buildHotwordSelector(),
        Expanded(
          child: NotificationListener<ScrollNotification>(
            onNotification: (ScrollNotification notification) {
              if (notification.metrics.axis == Axis.vertical && notification is ScrollUpdateNotification && notification.metrics.pixels >= notification.metrics.maxScrollExtent - 400) {
                if (!_isFetchingHotword && _hasMoreHotword) _fetchHotwordComments();
              }
              return false;
            },
            child: _hotwordComments.isEmpty && !_isFetchingHotword
                ? _buildEmptyState(context, '该热词下暂无评论', CupertinoIcons.chat_bubble_text)
                : ScrollConfiguration(
                    behavior: ScrollConfiguration.of(context).copyWith(scrollbars: false),
                    child: ListView.builder(
                      padding: const EdgeInsets.fromLTRB(24, 12, 24, 40),
                      itemCount: _hotwordComments.length + 1,
                      itemBuilder: (context, index) {
                        if (index < _hotwordComments.length) return _buildCommentItem(context, _hotwordComments[index]);
                        return _buildLoadingIndicator(_hasMoreHotword);
                      },
                    ),
                  ),
          ),
        ),
      ],
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
          final item = _classifyList[index];
          final isSelected = _selectedClassifyId == item['id'];
          return Padding(
            padding: const EdgeInsets.only(right: 10),
            child: ChoiceChip(
              label: Text('${item['label']} ${item['cnt'] ?? ''}'),
              selected: isSelected,
              onSelected: (selected) {
                if (selected) {
                  setState(() => _selectedClassifyId = item['id']);
                  _fetchClassifyComments(isRefresh: true);
                  _scrollToIndex(_classifyHeaderScrollController, index);
                }
              },
              selectedColor: theme.colorScheme.primary,
              labelStyle: TextStyle(color: isSelected ? Colors.white : theme.colorScheme.onSurface.withAlpha(180), fontSize: 12, fontWeight: isSelected ? FontWeight.w900 : FontWeight.w600),
              backgroundColor: theme.colorScheme.onSurface.withAlpha(10),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
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
          final item = _hotWordList[index];
          final isSelected = _selectedHotWord == item['content'];
          return Padding(
            padding: const EdgeInsets.only(right: 10),
            child: ChoiceChip(
              label: Text('${item['content']} ${item['count'] ?? ''}'),
              selected: isSelected,
              onSelected: (selected) {
                if (selected) {
                  setState(() => _selectedHotWord = item['content']);
                  _fetchHotwordComments(isRefresh: true);
                  _scrollToIndex(_hotwordHeaderScrollController, index);
                }
              },
              selectedColor: theme.colorScheme.primary,
              labelStyle: TextStyle(color: isSelected ? Colors.white : theme.colorScheme.onSurface.withAlpha(180), fontSize: 12, fontWeight: isSelected ? FontWeight.w900 : FontWeight.w600),
              backgroundColor: theme.colorScheme.onSurface.withAlpha(10),
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
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
    double offset = index * 100.0; 
    if (offset > controller.position.maxScrollExtent) offset = controller.position.maxScrollExtent;
    controller.animateTo(offset, duration: const Duration(milliseconds: 300), curve: Curves.easeInOutCubic);
  }

  Widget _buildLoadingIndicator(bool hasMore) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 20),
      child: Center(child: hasMore ? const CupertinoActivityIndicator() : Text('已加载全部评论', style: TextStyle(color: Theme.of(context).disabledColor, fontSize: 12))),
    );
  }

  int _calculateItemCount(String type, List displayList, List? starList) {
    if (type == 'hot') {
      int count = displayList.length;
      if (starList != null && starList.isNotEmpty) count += (starList.length + 2); 
      if (displayList.isNotEmpty) count += 1; 
      return count;
    } else return displayList.length + 1; 
  }

  Widget _buildItem(BuildContext context, int index, String type, List displayList, List? starList) {
    int offset = 0;
    if (type == 'hot') {
      if (starList != null && starList.isNotEmpty) {
        if (index == 0) return _buildSectionHeader('歌手说');
        if (index <= starList.length) return _buildCommentItem(context, starList[index - 1], isStar: true);
        offset = starList.length + 1;
        if (index == offset) return const SizedBox(height: 24);
        offset++;
      }
      if (index == offset) return _buildSectionHeader('热门评论');
      int cmtIndex = index - offset - 1;
      if (cmtIndex >= 0 && cmtIndex < displayList.length) return _buildCommentItem(context, displayList[cmtIndex]);
    } else {
      if (index < displayList.length) return _buildCommentItem(context, displayList[index]);
      return _buildLoadingIndicator(_hasMore);
    }
    return const SizedBox.shrink();
  }

  Widget _buildCommentItem(BuildContext context, Map comment, {bool isStar = false}) {
    final theme = Theme.of(context);
    final likeCount = comment['like']?['count'] ?? 0;
    return Container(
      margin: const EdgeInsets.only(bottom: 16),
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(color: isStar ? theme.colorScheme.primary.withAlpha(10) : theme.colorScheme.onSurface.withAlpha(5), borderRadius: BorderRadius.circular(20), border: isStar ? Border.all(color: theme.colorScheme.primary.withAlpha(20)) : null),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              ClipRRect(borderRadius: BorderRadius.circular(18), child: Image.network(comment['user_pic'] ?? '', width: 36, height: 36, errorBuilder: (_,__,___) => const Icon(CupertinoIcons.person_alt_circle, size: 36))),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Text(comment['user_name'] ?? '匿名用户', style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w800)),
                        if (isStar) Container(margin: const EdgeInsets.only(left: 8), padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2), decoration: BoxDecoration(color: theme.colorScheme.primary, borderRadius: BorderRadius.circular(6)), child: const Text('歌手', style: TextStyle(fontSize: 9, color: Colors.white, fontWeight: FontWeight.bold))),
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
    return Padding(padding: const EdgeInsets.only(left: 4, bottom: 12, top: 8), child: Text(title, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w900, color: Colors.grey, letterSpacing: 1.0)));
  }

  Widget _buildLikeBadge(BuildContext context, int count) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(color: theme.colorScheme.surface, borderRadius: BorderRadius.circular(16), boxShadow: [BoxShadow(color: Colors.black.withAlpha(5), blurRadius: 10, offset: const Offset(0, 2))]),
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
  @override double get minExtent => 58;
  @override double get maxExtent => 58;
  @override Widget build(BuildContext context, double shrinkOffset, bool overlapsContent) { return child; }
  @override bool shouldRebuild(_SliverTabHeaderDelegate oldDelegate) { return false; }
}
