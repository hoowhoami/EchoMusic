import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';

import 'comment_item.dart';
import 'package:echomusic/theme/app_theme.dart';

List<Widget> buildResourceCommentSlivers({
  required BuildContext context,
  required bool isLoading,
  required List<dynamic> hotComments,
  required List<dynamic> comments,
  required int totalCount,
  String emptyMessage = '暂无评论',
  ValueChanged<Map<String, dynamic>>? onTapReplies,
}) {
  final hasAnyComments = hotComments.isNotEmpty || comments.isNotEmpty;
  if (isLoading && !hasAnyComments) {
    return const [
      SliverToBoxAdapter(
        child: Padding(
          padding: EdgeInsets.only(top: 72),
          child: Center(child: CupertinoActivityIndicator()),
        ),
      ),
    ];
  }

  final slivers = <Widget>[];

  if (hotComments.isNotEmpty) {
    slivers.add(_buildSectionHeader(context, '热门评论'));
    slivers.add(_buildCommentListSliver(hotComments, onTapReplies: onTapReplies));
  }

  slivers.add(
    _buildSectionHeader(
      context,
      '最新评论${totalCount > 0 ? ' ($totalCount)' : ''}',
    ),
  );

  if (comments.isEmpty) {
    slivers.add(
      SliverToBoxAdapter(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 24, 24, 40),
          child: Center(
            child: Text(
              emptyMessage,
              style: TextStyle(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
                fontSize: 13,
                fontWeight: AppTheme.fontWeightSemiBold,
              ),
            ),
          ),
        ),
      ),
    );
  } else {
    slivers.add(_buildCommentListSliver(comments, onTapReplies: onTapReplies));
  }

  slivers.add(const SliverToBoxAdapter(child: SizedBox(height: 40)));
  return slivers;
}

Widget _buildSectionHeader(BuildContext context, String title) {
  final theme = Theme.of(context);
  return SliverToBoxAdapter(
    child: Padding(
      padding: const EdgeInsets.fromLTRB(24, 16, 24, 8),
      child: Text(
        title,
        style: theme.textTheme.titleSmall?.copyWith(
          fontWeight: AppTheme.fontWeightSemiBold,
          color: theme.colorScheme.onSurface.withAlpha(180),
        ),
      ),
    ),
  );
}

Widget _buildCommentListSliver(
  List<dynamic> comments, {
  ValueChanged<Map<String, dynamic>>? onTapReplies,
}) {
  return SliverPadding(
    padding: const EdgeInsets.symmetric(horizontal: 8),
    sliver: SliverList(
      delegate: SliverChildBuilderDelegate((context, index) {
        final comment = _normalizeComment(comments[index]);
        final replyNum = _asInt(comment['reply_num']);
        return CommentItem(
          comment: comment,
          horizontalMargin: 16,
          onTapReplies: replyNum > 0 && onTapReplies != null
              ? () => onTapReplies(comment)
              : null,
        );
      }, childCount: comments.length),
    ),
  );
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