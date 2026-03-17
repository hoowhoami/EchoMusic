import 'dart:math' as math;

import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';

import 'comment_item.dart';
import 'package:echomusic/theme/app_theme.dart';

typedef FloorCommentsFetcher = Future<Map<String, dynamic>> Function({
  required int page,
  required int pagesize,
});

Future<T?> showCommentFloorSheet<T>(
  BuildContext context, {
  required Map<String, dynamic> comment,
  required FloorCommentsFetcher onFetch,
  String title = '楼层评论',
  String emptyMessage = '暂无回复',
  String unavailableMessage = '楼层评论暂不可用',
}) {
  return showModalBottomSheet<T>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: Colors.transparent,
    builder: (context) => _CommentFloorSheet(
      comment: comment,
      onFetch: onFetch,
      title: title,
      emptyMessage: emptyMessage,
      unavailableMessage: unavailableMessage,
    ),
  );
}

class _CommentFloorSheet extends StatefulWidget {
  const _CommentFloorSheet({
    required this.comment,
    required this.onFetch,
    required this.title,
    required this.emptyMessage,
    required this.unavailableMessage,
  });

  final Map<String, dynamic> comment;
  final FloorCommentsFetcher onFetch;
  final String title;
  final String emptyMessage;
  final String unavailableMessage;

  @override
  State<_CommentFloorSheet> createState() => _CommentFloorSheetState();
}

class _CommentFloorSheetState extends State<_CommentFloorSheet> {
  static const int _pageSize = 30;
  static const double _loadMoreTriggerExtent = 240;

  final ScrollController _scrollController = ScrollController();

  bool _isLoading = true;
  bool _isLoadingMore = false;
  bool _hasMore = false;
  List<dynamic> _replies = const [];
  int _currentPage = 0;
  int _totalCount = 0;
  String? _message;
  String? _loadMoreMessage;

  @override
  void initState() {
    super.initState();
    _scrollController.addListener(_handleScroll);
    _loadReplies();
  }

  @override
  void dispose() {
    _scrollController.removeListener(_handleScroll);
    _scrollController.dispose();
    super.dispose();
  }

  void _handleScroll() {
    if (!_scrollController.hasClients) return;
    if (_scrollController.position.extentAfter > _loadMoreTriggerExtent) {
      return;
    }
    _loadReplies(loadMore: true);
  }

  Future<void> _loadReplies({bool loadMore = false}) async {
    if (loadMore) {
      if (_isLoading || _isLoadingMore || !_hasMore) return;
    }

    final nextPage = loadMore ? _currentPage + 1 : 1;
    if (!loadMore && mounted) {
      setState(() {
        _isLoading = true;
        _message = null;
        _loadMoreMessage = null;
      });
    } else if (loadMore && mounted) {
      setState(() {
        _isLoadingMore = true;
        _loadMoreMessage = null;
      });
    }

    try {
      final data = await widget.onFetch(page: nextPage, pagesize: _pageSize);
      final payload = data['data'] is Map<String, dynamic>
          ? data['data'] as Map<String, dynamic>
          : data;
      final replies = payload['list'] is List
          ? List<dynamic>.from(payload['list'] as List)
          : const <dynamic>[];
      final totalCount = _asInt(payload['comments_num'] ?? data['comments_num']);
      final errCode = _asInt(payload['err_code'] ?? data['err_code']);
      final remoteMessage = (payload['message'] ??
              payload['msg'] ??
              data['message'] ??
              data['msg'])
          ?.toString();
      final mergedReplies = loadMore
          ? <dynamic>[..._replies, ...replies]
          : replies;
      final hasMore = totalCount > 0
          ? mergedReplies.length < totalCount
          : replies.length >= _pageSize;

      if (!mounted) return;
      setState(() {
        _isLoading = false;
        _isLoadingMore = false;
        _replies = mergedReplies;
        _currentPage = nextPage;
        _totalCount = totalCount;
        _hasMore = mergedReplies.isNotEmpty && hasMore;
        _message = mergedReplies.isNotEmpty
            ? null
            : errCode != 0
                ? widget.unavailableMessage
                : (remoteMessage?.isNotEmpty ?? false)
                    ? remoteMessage
                    : widget.emptyMessage;
        _loadMoreMessage = null;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        if (loadMore) {
          _isLoadingMore = false;
          _loadMoreMessage = '加载更多失败，点击重试';
        } else {
          _isLoading = false;
          _hasMore = false;
          _message = widget.unavailableMessage;
        }
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final sheetHeight = math.min(MediaQuery.of(context).size.height * 0.82, 720.0);

    return Align(
      alignment: Alignment.bottomCenter,
      child: Container(
        height: sheetHeight,
        decoration: BoxDecoration(
          color: theme.scaffoldBackgroundColor,
          borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
        ),
        child: Column(
          children: [
            const SizedBox(height: 10),
            Container(
              width: 44,
              height: 4,
              decoration: BoxDecoration(
                color: theme.colorScheme.onSurface.withAlpha(40),
                borderRadius: BorderRadius.circular(999),
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 14, 12, 10),
              child: Row(
                children: [
                  Expanded(
                    child: Text(
                      widget.title,
                      style: theme.textTheme.titleMedium?.copyWith(
                        fontWeight: AppTheme.fontWeightBold,
                      ),
                    ),
                  ),
                  IconButton(
                    onPressed: () => Navigator.of(context).pop(),
                    icon: const Icon(CupertinoIcons.clear),
                    splashRadius: 18,
                  ),
                ],
              ),
            ),
            Expanded(
              child: _isLoading
                  ? const Center(child: CupertinoActivityIndicator())
                  : ListView(
                      controller: _scrollController,
                      padding: const EdgeInsets.fromLTRB(0, 0, 0, 20),
                      children: [
                        _buildSectionTitle(context, '原评论'),
                        CommentItem(comment: widget.comment, showDivider: false),
                        _buildSectionTitle(
                          context,
                          '回复${_totalCount > 0 ? ' ($_totalCount)' : ''}',
                        ),
                        if (_replies.isEmpty)
                          Padding(
                            padding: const EdgeInsets.fromLTRB(24, 36, 24, 24),
                            child: Center(
                              child: Text(
                                _message ?? widget.emptyMessage,
                                style: TextStyle(
                                  color: theme.colorScheme.onSurfaceVariant,
                                  fontSize: 13,
                                  fontWeight: AppTheme.fontWeightSemiBold,
                                ),
                                textAlign: TextAlign.center,
                              ),
                            ),
                          )
                        else
                          for (final reply in _replies)
                            CommentItem(
                              comment: _normalizeComment(reply),
                              showDivider: reply != _replies.last,
                            ),
                        if (_replies.isNotEmpty)
                          _buildLoadMoreSection(context),
                      ],
                    ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildSectionTitle(BuildContext context, String title) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 8, 20, 6),
      child: Text(
        title,
        style: theme.textTheme.labelLarge?.copyWith(
          color: theme.colorScheme.onSurfaceVariant,
          fontWeight: AppTheme.fontWeightBold,
        ),
      ),
    );
  }

  Widget _buildLoadMoreSection(BuildContext context) {
    final theme = Theme.of(context);
    if (_isLoadingMore) {
      return const Padding(
        padding: EdgeInsets.fromLTRB(20, 12, 20, 16),
        child: Center(child: CupertinoActivityIndicator()),
      );
    }

    final label = _loadMoreMessage ?? (_hasMore ? '加载更多回复' : null);
    if (label == null) {
      return const SizedBox(height: 8);
    }

    return Padding(
      padding: const EdgeInsets.fromLTRB(20, 8, 20, 12),
      child: Center(
        child: TextButton(
          onPressed: () => _loadReplies(loadMore: true),
          child: Text(
            label,
            style: theme.textTheme.labelLarge?.copyWith(
              fontWeight: AppTheme.fontWeightBold,
            ),
          ),
        ),
      ),
    );
  }
}

Map<String, dynamic> _normalizeComment(dynamic comment) {
  if (comment is Map<String, dynamic>) return comment;
  if (comment is Map) return Map<String, dynamic>.from(comment);
  return <String, dynamic>{};
}

int _asInt(dynamic value) {
  if (value is int) return value;
  return int.tryParse(value?.toString() ?? '') ?? 0;
}