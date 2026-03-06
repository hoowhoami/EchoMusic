import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import '../../models/song.dart';
import '../../providers/audio_provider.dart';
import 'cover_image.dart';
import 'custom_dialog.dart';
import 'custom_toast.dart';

class QueueDrawer extends StatefulWidget {
  const QueueDrawer({super.key});

  @override
  State<QueueDrawer> createState() => _QueueDrawerState();
}

class _QueueDrawerState extends State<QueueDrawer> {
  final ScrollController _scrollController = ScrollController();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final audioProvider = context.read<AudioProvider>();
      _scrollToCurrent(audioProvider);
    });
  }

  @override
  void dispose() {
    _scrollController.dispose();
    super.dispose();
  }

  void _scrollToCurrent(AudioProvider audioProvider) {
    if (audioProvider.currentIndex >= 0 && _scrollController.hasClients) {
      _scrollController.animateTo(
        audioProvider.currentIndex * 60.0,
        duration: const Duration(milliseconds: 500),
        curve: Curves.easeOutCubic,
      );
    }
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
        boxShadow: [
          BoxShadow(
            color: Colors.black.withAlpha(40),
            blurRadius: 20,
            offset: const Offset(0, -5),
          ),
        ],
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
                        fontWeight: FontWeight.w900,
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
                            fontWeight: FontWeight.w600,
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
                margin: const EdgeInsets.fromLTRB(16, 12, 16, 4),
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
                          fontWeight: FontWeight.w600,
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
                              fontWeight: FontWeight.w600,
                              color: theme.colorScheme.onSurfaceVariant,
                            ),
                          ),
                        ],
                      ),
                    ),
                  );
                }

                return ScrollConfiguration(
                  behavior: ScrollConfiguration.of(context).copyWith(scrollbars: false),
                  child: ListView.builder(
                    controller: _scrollController,
                    padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 12),
                    itemCount: playlist.length,
                    itemExtent: 60,
                    itemBuilder: (context, index) {
                      final song = playlist[index];
                      final isCurrent = index == currentIndex;
                      final isPlaying = isCurrent && audioProvider.isPlaying;

                      return _QueueItem(
                        song: song,
                        isCurrent: isCurrent,
                        isPlaying: isPlaying,
                        onTap: () => audioProvider.playSong(song, playlist: playlist),
                        onRemove: () => audioProvider.removeFromPlaylist(index),
                      );
                    },
                  ),
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
  final Song song;
  final bool isCurrent;
  final bool isPlaying;
  final VoidCallback onTap;
  final VoidCallback onRemove;

  const _QueueItem({
    required this.song,
    required this.isCurrent,
    required this.isPlaying,
    required this.onTap,
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

    return MouseRegion(
      cursor: isPlayable ? SystemMouseCursors.click : SystemMouseCursors.forbidden,
      onEnter: (_) => setState(() => _isHovered = true),
      onExit: (_) => setState(() => _isHovered = false),
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 1),
        child: Material(
          color: Colors.transparent,
          child: InkWell(
            onTap: isPlayable ? widget.onTap : () => CustomToast.error(context, '该歌曲暂无可用音源'),
            borderRadius: BorderRadius.circular(12),
            hoverColor: theme.colorScheme.primary.withAlpha(15),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              child: Row(
                children: [
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
                      if (widget.isCurrent)
                        Container(
                          width: 44,
                          height: 44,
                          decoration: BoxDecoration(
                            color: theme.colorScheme.primary.withAlpha(100),
                            borderRadius: BorderRadius.circular(8),
                          ),
                          child: Center(
                            child: Icon(
                              widget.isPlaying ? CupertinoIcons.pause_fill : CupertinoIcons.play_fill,
                              color: Colors.white,
                              size: 16,
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
                        Text(
                          widget.song.name,
                          style: TextStyle(
                            fontSize: 14,
                            fontWeight: widget.isCurrent ? FontWeight.w800 : FontWeight.w700,
                            color: (widget.isCurrent ? theme.colorScheme.primary : theme.colorScheme.onSurface)
                                .withAlpha(isPlayable ? 255 : 140),
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        const SizedBox(height: 2),
                        Text(
                          isPlayable ? widget.song.singerName : '${widget.song.singerName} · 无音源',
                          style: TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.w600,
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
