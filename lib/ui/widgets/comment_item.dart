import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'cover_image.dart';

class CommentItem extends StatelessWidget {
  const CommentItem({
    super.key,
    required this.comment,
    this.onTapReplies,
    this.showDivider = true,
    this.horizontalMargin = 20,
  });

  final dynamic comment;
  final VoidCallback? onTapReplies;
  final bool showDivider;
  final double horizontalMargin;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final String content = comment['content']?.toString() ?? '';
    final String userName = comment['user_name']?.toString() ?? '匿名用户';
    final String userPic = comment['user_pic']?.toString() ?? '';
    final String addTime = comment['addtime']?.toString() ?? '';
    final int likeCount = _asInt(comment['like']?['count']);
    final int replyNum = _asInt(comment['reply_num']);
    final replyColor = onTapReplies != null
        ? theme.colorScheme.primary
        : theme.colorScheme.onSurface.withAlpha(120);

    return Container(
      margin: EdgeInsets.fromLTRB(
        horizontalMargin,
        0,
        horizontalMargin,
        showDivider ? 12 : 0,
      ),
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: theme.colorScheme.onSurface.withAlpha(5),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(18),
                child: userPic.isNotEmpty
                    ? CoverImage(
                        url: userPic,
                        width: 36,
                        height: 36,
                        borderRadius: 0,
                        showShadow: false,
                      )
                    : Container(
                        width: 36,
                        height: 36,
                        color: theme.colorScheme.primary.withAlpha(12),
                        alignment: Alignment.center,
                        child: Icon(
                          CupertinoIcons.person_fill,
                          size: 18,
                          color: theme.colorScheme.primary,
                        ),
                      ),
                  ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      userName,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w800,
                        color: theme.colorScheme.onSurface,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      addTime,
                      style: TextStyle(
                        fontSize: 10,
                        color: theme.colorScheme.onSurface.withAlpha(100),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(width: 12),
              _buildLikeBadge(context, likeCount),
            ],
          ),
          const SizedBox(height: 12),
          Text(
            content,
            style: TextStyle(
              fontSize: 14,
              height: 1.5,
              fontWeight: FontWeight.w500,
              color: theme.colorScheme.onSurface,
            ),
          ),
          if (replyNum > 0) ...[
            const SizedBox(height: 12),
            Material(
              color: Colors.transparent,
              child: InkWell(
                onTap: onTapReplies,
                borderRadius: BorderRadius.circular(999),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 4),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(
                        CupertinoIcons.chat_bubble_2,
                        size: 14,
                        color: replyColor,
                      ),
                      const SizedBox(width: 6),
                      Text(
                        onTapReplies != null
                            ? '查看$replyNum条回复'
                            : '$replyNum 条回复',
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w700,
                          color: replyColor,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ],
        ],
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
}

String _formatBigNumber(int number) {
  if (number < 10000) return number.toString();
  return '${(number / 10000).toStringAsFixed(1)}w';
}

int _asInt(dynamic value) {
  if (value is int) return value;
  return int.tryParse(value?.toString() ?? '') ?? 0;
}
