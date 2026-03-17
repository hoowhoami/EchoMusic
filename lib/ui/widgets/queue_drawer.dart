import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import '../../models/song.dart';
import '../../providers/audio_provider.dart';
import 'cover_image.dart';
import 'custom_dialog.dart';
import 'custom_toast.dart';
import 'package:echomusic/theme/app_theme.dart';

class QueueDrawer extends StatefulWidget {
  const QueueDrawer({super.key});

  @override
  State<QueueDrawer> createState() => _QueueDrawerState();
}

class _QueueDrawerState extends State<QueueDrawer> {
  static const double _queueItemExtent = 60.0;

  final ScrollController _scrollController = ScrollController();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final audioProvider = context.read<AudioProvider>();
      _scrollToCurrent(audioProvider, animated: false);
    });
  }

  @override
  void dispose() {
    _scrollController.dispose();
    super.dispose();
  }

  void _scrollToCurrent(AudioProvider audioProvider, {bool animated = true}) {
    if (audioProvider.currentIndex < 0 || !_scrollController.hasClients) return;

    final position = _scrollController.position;
    final itemTop = audioProvider.currentIndex * _queueItemExtent;
    final itemBottom = itemTop + _queueItemExtent;
    final visibleTop = position.pixels;
    final visibleBottom = visibleTop + position.viewportDimension;

    if (itemTop >= visibleTop && itemBottom <= visibleBottom) return;

    final targetOffset = itemTop < visibleTop
        ? itemTop
        : (itemBottom - position.viewportDimension)
            .clamp(0.0, position.maxScrollExtent)
            .toDouble();

    if ((targetOffset - position.pixels).abs() < 1.0) return;

    if (animated) {
      _scrollController.animateTo(
        targetOffset,
        duration: const Duration(milliseconds: 500),
        curve: Curves.easeOutCubic,
      );
      return;
    }

    _scrollController.jumpTo(targetOffset);
  }

  void _scrollToTop() {
    if (_scrollController.hasClients) {
      _scrollController.animateTo(
        0,
        duration: const Duration(milliseconds: 500),
        curve: Curves.easeOutCubic,
      );
    }
  }

  void _showClearConfirm(BuildContext context, AudioProvider audioProvider) {
    CustomDialog.show(
      context,
      title: '清空播放列表',
      content: '确定要清空当前的播放列表吗？',
      confirmText: '清空',
      isDestructive: true,
    ).then((confirmed) {
      if (confirmed == true) {
        audioProvider.clearPlaylist();
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Container(
      decoration: BoxDecoration(
        color: theme.colorScheme.surface,
        borderRadius: const BorderRadius.horizontal(left: Radius.circular(16)),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          // Header
          Container(
            padding: const EdgeInsets.fromLTRB(24, 20, 16, 16),
            child: Row(
              children: [
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '播放列表',
                      style: TextStyle(
                        fontSize: 18,
                        fontWeight: AppTheme.fontWeightBold,
                        color: theme.colorScheme.onSurface,
                        letterSpacing: -0.5,
                      ),
                    ),
                    Consumer<AudioProvider>(
                      builder: (context, audio, child) {
                        return Text(
                          '共 ${audio.playlist.length} 首歌曲',
                          style: TextStyle(
                            fontSize: 12,
                            fontWeight: AppTheme.fontWeightSemiBold,
                            color: theme.colorScheme.onSurfaceVariant,
                          ),
                        );
                      },
                    ),
                  ],
                ),
                const Spacer(),
                Consumer<AudioProvider>(
                  builder: (context, audioProvider, child) {
                    if (audioProvider.playlist.isEmpty) return const SizedBox.shrink();
                    return Row(
                      children: [
                        Tooltip(
                          message: '滚动到顶部',
                          child: IconButton(
                            onPressed: _scrollToTop,
                            icon: Icon(
                              CupertinoIcons.arrow_up,
                              size: 18,
                              color: theme.colorScheme.onSurface.withAlpha(150),
                            ),
                          ),
                        ),
                        Tooltip(
                          message: '滚动到当前播放',
                          child: IconButton(
                            onPressed: () => _scrollToCurrent(audioProvider),
                            icon: Icon(
                              CupertinoIcons.scope,
                              size: 18,
                              color: theme.colorScheme.onSurface.withAlpha(150),
                            ),
                          ),
                        ),
                        Tooltip(
                          message: '清空列表',
                          child: IconButton(
                            onPressed: () => _showClearConfirm(context, audioProvider),
                            icon: Icon(
                              CupertinoIcons.trash,
                              size: 18,
                              color: theme.colorScheme.onSurface.withAlpha(150),
                            ),
                            hoverColor: theme.colorScheme.error.withAlpha(20),
                          ),
                        ),
                      ],
                    );
                  },
                ),
                IconButton(
                  onPressed: () => Navigator.of(context).pop(),
                  icon: const Icon(CupertinoIcons.xmark, size: 20),
                ),
              ],
            ),
          ),

          const Divider(height: 1, indent: 24, endIndent: 24),

          Selector<AudioProvider, int>(
            selector: (_, audio) => audio.activePlaylistFilteredInvalidSongCount,
            builder: (context, filteredCount, child) {
              if (filteredCount <= 0) return const SizedBox.shrink();

              return Container(
                width: double.infinity,
                margin: const EdgeInsets.fromLTRB(24, 12, 24, 4),
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                decoration: BoxDecoration(
                  color: theme.colorScheme.primary.withAlpha(12),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: theme.colorScheme.primary.withAlpha(35)),
                ),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Icon(
                      CupertinoIcons.info_circle,
                      size: 16,
                      color: theme.colorScheme.primary,
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        '当前播放列表已过滤 $filteredCount 条无效歌曲数据',
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: AppTheme.fontWeightSemiBold,
                          color: theme.colorScheme.onSurface,
                          height: 1.35,
                        ),
                      ),
                    ),
                  ],
                ),
              );
            },
          ),

          // Queue List
          Flexible(
            child: Consumer<AudioProvider>(
              builder: (context, audioProvider, child) {
                final playlist = audioProvider.playlist;
                final currentIndex = audioProvider.currentIndex;
                final canReorder = true;

                if (playlist.isEmpty) {
                  return SizedBox(
                    height: 300,
                    child: Center(
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Icon(
                            CupertinoIcons.music_note_list,
                            size: 48,
                            color: theme.colorScheme.onSurface.withAlpha(40),
                          ),
                          const SizedBox(height: 16),
                          Text(
                            '列表为空，快去发现好音乐吧',
                            style: TextStyle(
                              fontSize: 14,
                              fontWeight: AppTheme.fontWeightSemiBold,
                              color: theme.colorScheme.onSurfaceVariant,
                            ),
                          ),
                        ],
                      ),
                    ),
                  );
                }

                return ReorderableListView.builder(
                  buildDefaultDragHandles: false,
                  scrollController: _scrollController,
                  padding: const EdgeInsets.fromLTRB(14, 8, 18, 8),
                  itemCount: playlist.length,
                  proxyDecorator: (child, index, animation) {
                    final background = theme.colorScheme.surface;
                    return Material(
                      color: Colors.transparent,
                      child: Container(
                        decoration: BoxDecoration(
                          color: background,
                          borderRadius: BorderRadius.circular(14),
                          boxShadow: [
                            BoxShadow(
                              color: Colors.black.withAlpha(28),
                              blurRadius: 14,
                              offset: const Offset(0, 6),
                            ),
                          ],
                        ),
                        child: child,
                      ),
                    );
                  },
                  onReorder: (oldIndex, newIndex) {
                    final targetIndex =
                        newIndex > oldIndex ? newIndex - 1 : newIndex;
                    audioProvider.reorderPlaylist(oldIndex, targetIndex);
                  },
                  itemBuilder: (context, index) {
                    final song = playlist[index];
                    final isCurrent = index == currentIndex;
                    final isPlaying = isCurrent && audioProvider.isPlaying;

                    return ReorderableDelayedDragStartListener(
                      key: ObjectKey(song),
                      index: index,
                      child: SizedBox(
                        height: _queueItemExtent,
                        child: _QueueItem(
                          index: index,
                          song: song,
                          isCurrent: isCurrent,
                          isPlaying: isPlaying,
                          onPlay: () {
                            if (isCurrent) {
                              audioProvider.togglePlay();
                            } else {
                              audioProvider.playSong(song);
                            }
                          },
                          onRemove: () =>
                              audioProvider.removeFromPlaylist(index),
                        ),
                      ),
                    );
                  },
                );
              },
            ),
          ),
          const SizedBox(height: 12),
        ],
      ),
    );
  }
}

class _QueueItem extends StatefulWidget {
  final int index;
  final Song song;
  final bool isCurrent;
  final bool isPlaying;
  final VoidCallback onPlay;
  final VoidCallback onRemove;

  const _QueueItem({
    required this.index,
    required this.song,
    required this.isCurrent,
    required this.isPlaying,
    required this.onPlay,
    required this.onRemove,
  });

  @override
  State<_QueueItem> createState() => _QueueItemState();
}

class _QueueItemState extends State<_QueueItem> {
  bool _isHovered = false;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isPlayable = widget.song.isPlayable;
    final isNoCopyright = widget.song.isNoCopyright;
    final isPayBlocked = widget.song.isPayBlocked || widget.song.isPaid;
    final unavailableMessage = isNoCopyright
        ? '该歌曲暂无版权'
        : isPayBlocked
            ? '该歌曲需要购买'
            : '该歌曲暂无可用音源';
    final unavailableTag = !isPlayable
        ? (isNoCopyright
            ? '版权'
            : isPayBlocked
                ? '付费'
                : '音源')
        : null;

    final showPlayButton = _isHovered || widget.isCurrent;
    final displayIndex = (widget.index + 1).toString();

    return MouseRegion(
      cursor: SystemMouseCursors.basic,
      onEnter: (_) => setState(() => _isHovered = true),
      onExit: (_) => setState(() => _isHovered = false),
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 1),
        child: Material(
          color: Colors.transparent,
          child: InkWell(
            onTap: null,
            onDoubleTap: isPlayable
                ? widget.onPlay
                : () => CustomToast.error(context, unavailableMessage),
            borderRadius: BorderRadius.circular(12),
            hoverColor: theme.colorScheme.primary.withAlpha(15),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 8, 14, 8),
              child: Row(
                children: [
                  SizedBox(
                    width: 32,
                    child: Stack(
                      alignment: Alignment.center,
                      children: [
                        AnimatedOpacity(
                          opacity: showPlayButton ? 0.0 : 1.0,
                          duration: const Duration(milliseconds: 160),
                          curve: Curves.easeOut,
                          child: Text(
                            displayIndex,
                            style: TextStyle(
                              fontSize: 12,
                              fontWeight: widget.isCurrent
                                  ? AppTheme.fontWeightBold
                                  : AppTheme.fontWeightSemiBold,
                              color: (widget.isCurrent
                                      ? theme.colorScheme.primary
                                      : theme.colorScheme.onSurfaceVariant)
                                  .withAlpha(isPlayable ? 200 : 120),
                            ),
                          ),
                        ),
                        AnimatedOpacity(
                          opacity: showPlayButton ? 1.0 : 0.0,
                          duration: const Duration(milliseconds: 160),
                          curve: Curves.easeOut,
                          child: IgnorePointer(
                            ignoring: !showPlayButton,
                            child: _PlayQueueButton(
                              isPlayable: isPlayable,
                              isCurrent: widget.isCurrent,
                              isPlaying: widget.isPlaying,
                              onPressed: isPlayable
                                  ? widget.onPlay
                                  : () => CustomToast.error(
                                        context,
                                        unavailableMessage,
                                      ),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 8),
                  Stack(
                    children: [
                      CoverImage(
                        url: widget.song.cover,
                        width: 44,
                        height: 44,
                        borderRadius: 8,
                        showShadow: false,
                        size: 100,
                      ),
                      if (!isPlayable)
                        Positioned.fill(
                          child: Container(
                            decoration: BoxDecoration(
                              color: theme.colorScheme.surface.withAlpha(120),
                              borderRadius: BorderRadius.circular(8),
                            ),
                          ),
                        ),
                    ],
                  ),
                  const SizedBox(width: 14),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Row(
                          children: [
                            Flexible(
                              child: Text(
                                widget.song.name,
                                style: TextStyle(
                                  fontSize: 14,
                                  fontWeight: widget.isCurrent
                                      ? AppTheme.fontWeightBold
                                      : AppTheme.fontWeightBold,
                                  color: (widget.isCurrent
                                          ? theme.colorScheme.primary
                                          : theme.colorScheme.onSurface)
                                      .withAlpha(isPlayable ? 255 : 140),
                                ),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                            if (unavailableTag != null)
                              _buildTag(context, unavailableTag, theme),
                          ],
                        ),
                        const SizedBox(height: 2),
                        Text(
                          widget.song.singerName,
                          style: TextStyle(
                            fontSize: 12,
                            fontWeight: AppTheme.fontWeightSemiBold,
                            color: theme.colorScheme.onSurfaceVariant.withAlpha(isPlayable ? 255 : 140),
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ],
                    ),
                  ),
                  if (_isHovered && !widget.isCurrent)
                    IconButton(
                      icon: const Icon(CupertinoIcons.xmark, size: 14),
                      onPressed: widget.onRemove,
                      padding: const EdgeInsets.all(10),
                      constraints: const BoxConstraints(),
                      splashRadius: 20,
                      hoverColor: theme.colorScheme.error.withAlpha(20),
                      color: theme.colorScheme.onSurface.withAlpha(isPlayable ? 80 : 60),
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}


Widget _buildTag(BuildContext context, String text, ThemeData theme) {
  return Container(
    margin: const EdgeInsets.only(left: 6),
    padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1.5),
    decoration: BoxDecoration(
      color: theme.colorScheme.outline.withAlpha(20),
      border: Border.all(
        color: theme.colorScheme.outline.withAlpha(100),
        width: 0.5,
      ),
      borderRadius: BorderRadius.circular(6),
    ),
    child: Text(
      text,
      style: TextStyle(
        color: theme.colorScheme.outline,
        fontSize: 9,
        fontWeight: AppTheme.fontWeightBold,
        letterSpacing: 0.5,
      ),
    ),
  );
}

class _PlayQueueButton extends StatelessWidget {
  final bool isPlayable;
  final bool isCurrent;
  final bool isPlaying;
  final VoidCallback onPressed;

  const _PlayQueueButton({
    required this.isPlayable,
    required this.isCurrent,
    required this.isPlaying,
    required this.onPressed,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final color = isPlayable
        ? (isCurrent
              ? theme.colorScheme.primary
              : theme.colorScheme.onSurface.withAlpha(170))
        : theme.disabledColor;
    return IconButton(
      onPressed: isPlayable ? onPressed : null,
      icon: Icon(
        isCurrent && isPlaying
            ? CupertinoIcons.pause_fill
            : CupertinoIcons.play_fill,
        size: 16,
        color: color,
      ),
      padding: const EdgeInsets.all(6),
      constraints: const BoxConstraints(minWidth: 28, minHeight: 28),
      splashRadius: 18,
      hoverColor: Colors.transparent,
      highlightColor: Colors.transparent,
      splashColor: Colors.transparent,
    );
  }
}
