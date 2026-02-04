import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import '../../providers/selection_provider.dart';
import '../../providers/user_provider.dart';
import '../../providers/audio_provider.dart';
import '../../providers/persistence_provider.dart';

class BatchActionBar extends StatelessWidget {
  const BatchActionBar({super.key});

  @override
  Widget build(BuildContext context) {
    final selectionProvider = context.watch<SelectionProvider>();
    final isDark = Theme.of(context).brightness == Brightness.dark;

    if (!selectionProvider.isSelectionMode) {
      return const SizedBox.shrink();
    }

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
      decoration: BoxDecoration(
        color: isDark ? const Color(0xFF2C2C2E) : Colors.white,
        border: Border(
          top: BorderSide(
            color: isDark ? Colors.white.withAlpha(10) : Colors.black.withAlpha(10),
            width: 1,
          ),
        ),
        boxShadow: [
          BoxShadow(
            color: Colors.black.withAlpha(10),
            blurRadius: 8,
            offset: const Offset(0, -2),
          ),
        ],
      ),
      child: SafeArea(
        top: false,
        child: Row(
          children: [
            Text(
              '已选 ${selectionProvider.selectedCount} 首',
              style: TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.w600,
                color: isDark ? Colors.white : Colors.black87,
              ),
            ),
            const Spacer(),
            CupertinoButton(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
              onPressed: selectionProvider.hasSelection
                  ? () => selectionProvider.clearSelection()
                  : null,
              child: Text(
                '清空',
                style: TextStyle(
                  fontSize: 14,
                  color: selectionProvider.hasSelection
                      ? (isDark ? Colors.white70 : Colors.black54)
                      : (isDark ? Colors.white24 : Colors.black26),
                ),
              ),
            ),
            CupertinoButton(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
              onPressed: selectionProvider.selectedCount < selectionProvider.selectedSongs.length
                  ? () => selectionProvider.selectAll()
                  : null,
              child: Text(
                '全选',
                style: TextStyle(
                  fontSize: 14,
                  color: selectionProvider.selectedCount < selectionProvider.selectedSongs.length
                      ? (isDark ? Colors.white70 : Colors.black54)
                      : (isDark ? Colors.white24 : Colors.black26),
                ),
              ),
            ),
            const SizedBox(width: 8),
            CupertinoButton(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              color: Theme.of(context).colorScheme.primary,
              borderRadius: BorderRadius.circular(8),
              onPressed: selectionProvider.hasSelection
                  ? () => _showBatchActions(context, selectionProvider)
                  : null,
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(CupertinoIcons.ellipsis, size: 16, color: Colors.white),
                  const SizedBox(width: 6),
                  Text(
                    '批量操作',
                    style: TextStyle(
                      color: Colors.white,
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  void _showBatchActions(BuildContext context, SelectionProvider selectionProvider) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final userProvider = context.read<UserProvider>();
    final isAuthenticated = userProvider.isAuthenticated;

    showCupertinoModalPopup(
      context: context,
      builder: (context) => Container(
        decoration: BoxDecoration(
          color: isDark ? const Color(0xFF1C1C1E) : Colors.white,
          borderRadius: const BorderRadius.vertical(top: Radius.circular(16)),
        ),
        child: SafeArea(
          top: false,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 36,
                height: 4,
                margin: const EdgeInsets.symmetric(vertical: 12),
                decoration: BoxDecoration(
                  color: isDark ? Colors.white.withAlpha(20) : Colors.black.withAlpha(10),
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 8),
                child: Row(
                  children: [
                    Text(
                      '批量操作',
                      style: TextStyle(
                        fontSize: 18,
                        fontWeight: FontWeight.w700,
                        color: isDark ? Colors.white : Colors.black,
                      ),
                    ),
                    const Spacer(),
                    CupertinoButton(
                      padding: EdgeInsets.zero,
                      onPressed: () => Navigator.pop(context),
                      child: Icon(
                        CupertinoIcons.xmark,
                        size: 20,
                        color: isDark ? Colors.white54 : Colors.black54,
                      ),
                    ),
                  ],
                ),
              ),
              const Divider(height: 1),
              ListView(
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                children: [
                  if (isAuthenticated)
                    _buildActionItem(
                      context,
                      icon: CupertinoIcons.add_circled,
                      title: '添加到歌单',
                      subtitle: '将选中的 ${selectionProvider.selectedCount} 首歌曲添加到歌单',
                      onTap: () {
                        Navigator.pop(context);
                        _showAddToPlaylistDialog(context, selectionProvider);
                      },
                    ),
                  _buildActionItem(
                    context,
                    icon: CupertinoIcons.play_rectangle,
                    title: '播放选中',
                    subtitle: '立即播放选中的 ${selectionProvider.selectedCount} 首歌曲',
                    onTap: () {
                      Navigator.pop(context);
                      selectionProvider.exitSelectionMode();
                      // Play selected songs
                      final songs = selectionProvider.selectedSongs;
                      if (songs.isNotEmpty) {
                        context.read<AudioProvider>().playSong(songs.first, playlist: songs);
                      }
                    },
                  ),
                  if (isAuthenticated)
                    _buildActionItem(
                      context,
                      icon: CupertinoIcons.heart,
                      title: '添加到喜欢',
                      subtitle: '将选中的 ${selectionProvider.selectedCount} 首歌曲添加到我喜欢的',
                      onTap: () async {
                        Navigator.pop(context);
                        final persistenceProvider = context.read<PersistenceProvider>();
                        for (final song in selectionProvider.selectedSongs) {
                          await persistenceProvider.toggleFavorite(song);
                        }
                        selectionProvider.exitSelectionMode();
                        if (context.mounted) {
                          showCupertinoDialog(
                            context: context,
                            builder: (context) => CupertinoAlertDialog(
                              title: const Text('添加成功'),
                              content: Text('已添加 ${selectionProvider.selectedCount} 首歌曲到我喜欢的'),
                              actions: [
                                CupertinoDialogAction(
                                  child: const Text('确定'),
                                  onPressed: () => Navigator.pop(context),
                                ),
                              ],
                            ),
                          );
                        }
                      },
                    ),
                  _buildActionItem(
                    context,
                    icon: CupertinoIcons.multiply_circle,
                    title: '取消选择',
                    subtitle: '退出批量选择模式',
                    onTap: () {
                      Navigator.pop(context);
                      selectionProvider.exitSelectionMode();
                    },
                    isDestructive: true,
                  ),
                ],
              ),
              const SizedBox(height: 8),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildActionItem(
    BuildContext context, {
    required IconData icon,
    required String title,
    required String subtitle,
    required VoidCallback onTap,
    bool isDestructive = false,
  }) {
    final isDark = Theme.of(context).brightness == Brightness.dark;

    return CupertinoButton(
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
      onPressed: onTap,
      child: Row(
        children: [
          Icon(
            icon,
            size: 28,
            color: isDestructive
                ? CupertinoColors.destructiveRed
                : Theme.of(context).colorScheme.primary,
          ),
          const SizedBox(width: 16),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w600,
                    color: isDark ? Colors.white : Colors.black,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  subtitle,
                  style: TextStyle(
                    fontSize: 13,
                    color: isDark ? Colors.white54 : Colors.black54,
                  ),
                ),
              ],
            ),
          ),
          Icon(
            CupertinoIcons.chevron_right,
            size: 18,
            color: isDark ? Colors.white24 : Colors.black26,
          ),
        ],
      ),
    );
  }

  void _showAddToPlaylistDialog(BuildContext context, SelectionProvider selectionProvider) {
    // TODO: Show user's playlists to select from
    // This would need to fetch user playlists and display them
    showCupertinoDialog(
      context: context,
      builder: (context) => CupertinoAlertDialog(
        title: const Text('添加到歌单'),
        content: Text('将 ${selectionProvider.selectedCount} 首歌曲添加到歌单'),
        actions: [
          CupertinoDialogAction(
            child: const Text('取消'),
            onPressed: () => Navigator.pop(context),
          ),
          CupertinoDialogAction(
            isDefaultAction: true,
            child: const Text('创建新歌单'),
            onPressed: () {
              Navigator.pop(context);
              // TODO: Create new playlist
            },
          ),
        ],
      ),
    );
  }
}
