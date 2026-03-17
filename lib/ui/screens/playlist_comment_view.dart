import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import '../../api/music_api.dart';
import '../../models/playlist.dart';
import '../widgets/back_to_top.dart';
import '../widgets/comment_item.dart';
import 'package:echomusic/theme/app_theme.dart';

class PlaylistCommentView extends StatefulWidget {
  const PlaylistCommentView({super.key, required this.playlist});

  final Playlist playlist;

  @override
  State<PlaylistCommentView> createState() => _PlaylistCommentViewState();
}

class _PlaylistCommentViewState extends State<PlaylistCommentView> {
  final ScrollController _scrollController = ScrollController();

  bool _isLoading = false;
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
    _scrollController.addListener(_handleScroll);
    _fetchComments(isRefresh: true);
  }

  @override
  void dispose() {
    _scrollController.removeListener(_handleScroll);
    _scrollController.dispose();
    super.dispose();
  }

  void _handleScroll() {
    if (!_scrollController.hasClients) return;
    if (_scrollController.position.extentAfter > 400) return;
    if (!_isLoading && !_isFetchingMore && _hasMore) {
      _fetchComments();
    }
  }

  Future<void> _fetchComments({bool isRefresh = false}) async {
    if (_isFetchingMore && !isRefresh) return;

    setState(() {
      if (isRefresh) {
        _isLoading = true;
        _currentPage = 1;
        _allComments.clear();
        _hotComments.clear();
      } else {
        _isFetchingMore = true;
      }
    });

    try {
      final lookupId = widget.playlist.globalCollectionId ?? 'collection_3_${widget.playlist.listCreateUserid}_${widget.playlist.listCreateListid}_0';
      final data = await MusicApi.getPlaylistComments(
        lookupId,
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
        }

        _allComments.addAll(comments);
        _hasMore = comments.length >= _pageSize;
        _currentPage++;
        _isLoading = false;
        _isFetchingMore = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _isLoading = false;
        _isFetchingMore = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Scaffold(
      backgroundColor: theme.scaffoldBackgroundColor,
      appBar: AppBar(
        title: const Text('评论'),
        backgroundColor: theme.scaffoldBackgroundColor,
      ),
      body: Stack(
        children: [
          if (_isLoading && _allComments.isEmpty)
            const Center(child: CupertinoActivityIndicator())
          else
            CustomScrollView(
              controller: _scrollController,
              slivers: [
                if (_hotComments.isNotEmpty) ...[
                  SliverToBoxAdapter(
                    child: Padding(
                      padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
                      child: Text(
                        '热门评论',
                        style: TextStyle(
                          fontSize: 14,
                          fontWeight: AppTheme.fontWeightBold,
                          color: theme.colorScheme.onSurface.withAlpha(150),
                        ),
                      ),
                    ),
                  ),
                  SliverList(
                    delegate: SliverChildBuilderDelegate(
                      (context, index) => CommentItem(comment: _hotComments[index]),
                      childCount: _hotComments.length,
                    ),
                  ),
                ],
                SliverToBoxAdapter(
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
                    child: Text(
                      '最新评论 ${_totalCount > 0 ? '($_totalCount)' : ''}',
                      style: TextStyle(
                        fontSize: 14,
                        fontWeight: AppTheme.fontWeightBold,
                        color: theme.colorScheme.onSurface.withAlpha(150),
                      ),
                    ),
                  ),
                ),
                if (_allComments.isEmpty && !_isLoading)
                  SliverFillRemaining(
                    child: Center(
                      child: Text(
                        '暂无评论',
                        style: TextStyle(
                          color: theme.disabledColor,
                          fontSize: 14,
                        ),
                      ),
                    ),
                  )
                else
                  SliverList(
                    delegate: SliverChildBuilderDelegate(
                      (context, index) => CommentItem(comment: _allComments[index]),
                      childCount: _allComments.length,
                    ),
                  ),
                if (_isFetchingMore)
                  const SliverToBoxAdapter(
                    child: Padding(
                      padding: EdgeInsets.all(16),
                      child: Center(child: CupertinoActivityIndicator()),
                    ),
                  ),
                const SliverToBoxAdapter(child: SizedBox(height: 40)),
              ],
            ),
          BackToTop(controller: _scrollController),
        ],
      ),
    );
  }
}
