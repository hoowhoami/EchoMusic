import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import '../../models/song.dart';
import '../../providers/selection_provider.dart';
import '../../providers/user_provider.dart';
import '../../providers/audio_provider.dart';
import '../../providers/persistence_provider.dart';
import '../../theme/app_theme.dart';
import 'app_menu.dart';
import 'custom_toast.dart';
import 'playlist_picker_dialog.dart';

enum _BatchActionMenuResult {
  addToPlaylist,
  removeFromPlaylist,
  playNow,
  addToFavorite,
  cancelSelection,
}

class BatchActionBar extends StatefulWidget {
  const BatchActionBar({super.key});

  @override
  State<BatchActionBar> createState() => _BatchActionBarState();
}

class _BatchActionBarState extends State<BatchActionBar> with SingleTickerProviderStateMixin {
  String? _hoveredButton;
  late AnimationController _controller;
  late Animation<double> _animation;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      duration: const Duration(milliseconds: 400),
      vsync: this,
    );
    _animation = CurvedAnimation(
      parent: _controller,
      curve: Curves.easeOutBack,
    );
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final selectionProvider = context.watch<SelectionProvider>();
    final theme = Theme.of(context);
    final modernTheme = theme.extension<AppModernTheme>()!;

    if (selectionProvider.isSelectionMode) {
      _controller.forward();
    } else {
      _controller.reverse();
    }

    return AnimatedBuilder(
      animation: _animation,
      builder: (context, child) {
        if (_animation.value == 0 && !selectionProvider.isSelectionMode) {
          return const SizedBox.shrink();
        }
        
        // REFACTORED LAYOUT: Use Align to ensure it only blocks its own child's area.
        // We avoid Positioned.fill to prevent side blocking.
        return Align(
          alignment: Alignment.bottomCenter,
          child: IgnorePointer(
            ignoring: !selectionProvider.isSelectionMode,
            child: FadeTransition(
              opacity: _animation,
              child: ScaleTransition(
                scale: _animation,
                child: Padding(
                  padding: const EdgeInsets.only(bottom: 24),
                  child: child,
                ),
              ),
            ),
          ),
        );
      },
      child: ClipRRect(
        borderRadius: BorderRadius.circular(20),
        child: Container(
          // mainAxisSize: min in Row ensures the Container only wraps the content.
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 14),
          decoration: BoxDecoration(
            // FORCE OPAQUE
            color: Color.fromARGB(255, 
              ((modernTheme.batchBarColor ?? theme.colorScheme.surface).r * 255).round(),
              ((modernTheme.batchBarColor ?? theme.colorScheme.surface).g * 255).round(),
              ((modernTheme.batchBarColor ?? theme.colorScheme.surface).b * 255).round(),
            ),
            borderRadius: BorderRadius.circular(20),
            border: Border.all(
              color: theme.colorScheme.primary.withAlpha(30),
              width: 1.2,
            ),
            boxShadow: [
              BoxShadow(
                color: Colors.black.withAlpha(20),
                blurRadius: 20,
                offset: const Offset(0, 10),
              ),
            ],
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '已选择',
                    style: TextStyle(
                      fontSize: 11,
                      fontWeight: AppTheme.fontWeightSemiBold,
                      color: theme.colorScheme.onSurface.withAlpha(120),
                    ),
                  ),
                  Text(
                    '${selectionProvider.selectedCount} 首歌曲',
                    style: TextStyle(
                      fontSize: 15,
                      fontWeight: AppTheme.fontWeightSemiBold,
                      color: theme.colorScheme.onSurface,
                      letterSpacing: -0.5,
                    ),
                  ),
                ],
              ),
              const SizedBox(width: 32),
              _buildIconButton(
                icon: selectionProvider.selectedCount == selectionProvider.currentSongList.length && selectionProvider.currentSongList.isNotEmpty
                    ? CupertinoIcons.checkmark_square_fill
                    : (selectionProvider.selectedCount > 0 
                        ? CupertinoIcons.minus_square_fill 
                        : CupertinoIcons.square),
                label: selectionProvider.selectedCount == selectionProvider.currentSongList.length && selectionProvider.currentSongList.isNotEmpty
                    ? '全不选'
                    : '全选',
                onPressed: selectionProvider.currentSongList.isNotEmpty 
                    ? () {
                        if (selectionProvider.selectedCount == selectionProvider.currentSongList.length) {
                          selectionProvider.clearSelection();
                        } else {
                          selectionProvider.selectAll();
                        }
                      }
                    : null,
                id: 'select_all',
              ),
              _buildIconButton(
                icon: CupertinoIcons.play_fill,
                label: '播放',
                onPressed: selectionProvider.hasSelection ? () => _playSelected(context, selectionProvider) : null,
                id: 'play',
              ),
              Builder(
                builder: (buttonContext) => _buildIconButton(
                  icon: CupertinoIcons.add,
                  label: '添加',
                  onPressed: selectionProvider.hasSelection
                      ? () => _showBatchActions(
                          context,
                          selectionProvider,
                          buttonContext,
                        )
                      : null,
                  id: 'add',
                ),
              ),
              _buildIconButton(
                icon: CupertinoIcons.clear,
                label: '取消',
                onPressed: () => selectionProvider.exitSelectionMode(),
                id: 'cancel',
                isDestructive: true,
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildIconButton({
    required IconData icon,
    required String label,
    required VoidCallback? onPressed,
    required String id,
    bool isDestructive = false,
  }) {
    final theme = Theme.of(context);
    final isHovered = _hoveredButton == id;

    return MouseRegion(
      onEnter: (_) => setState(() => _hoveredButton = id),
      onExit: (_) => setState(() => _hoveredButton = null),
      child: CupertinoButton(
        padding: const EdgeInsets.symmetric(horizontal: 12),
        onPressed: onPressed,
        minimumSize: const Size(0, 0),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            AnimatedContainer(
              duration: const Duration(milliseconds: 200),
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: isHovered 
                  ? (isDestructive ? theme.colorScheme.error : theme.colorScheme.primary)
                  : (onPressed == null ? theme.disabledColor.withAlpha(20) : theme.colorScheme.primary.withAlpha(30)),
                shape: BoxShape.circle,
              ),
              child: Padding(
                padding: EdgeInsets.only(left: icon == CupertinoIcons.play_fill ? 2 : 0),
                child: Icon(
                  icon,
                  size: 18,
                  color: isHovered ? Colors.white : (isDestructive ? theme.colorScheme.error : theme.colorScheme.primary),
                ),
              ),
            ),
            const SizedBox(height: 4),
            Text(
              label,
              style: TextStyle(
                fontSize: 10,
                fontWeight: AppTheme.fontWeightSemiBold,
                color: isDestructive ? theme.colorScheme.error.withAlpha(200) : theme.colorScheme.onSurface.withAlpha(180),
              ),
            ),
          ],
        ),
      ),
    );
  }

  void _playSelected(BuildContext context, SelectionProvider selectionProvider) {
    selectionProvider.exitSelectionMode();
    _playSongs(context, selectionProvider.selectedSongs);
  }

  void _playSongs(BuildContext context, List<Song> songs) {
    if (songs.isEmpty) return;

    final hasPlayable = songs.any((song) => song.isPlayable);
    if (!hasPlayable) {
      if (songs.any((song) => song.isNoCopyright)) {
        CustomToast.error(context, '所选歌曲包含无版权内容');
      } else if (songs.any((song) => song.isPaid)) {
        CustomToast.error(context, '所选歌曲包含需要购买的内容');
      } else {
        CustomToast.error(context, '所选歌曲暂无可用音源');
      }
      return;
    }

    context.read<AudioProvider>().playSong(songs.first, playlist: songs);
  }

  Future<void> _showBatchActions(
    BuildContext context,
    SelectionProvider selectionProvider,
    BuildContext anchorContext,
  ) async {
    final userProvider = context.read<UserProvider>();
    final isAuthenticated = userProvider.isAuthenticated;
    final canRemoveFromPlaylist = isAuthenticated &&
        selectionProvider.sourcePlaylistId != null &&
        userProvider.isCreatedPlaylist(selectionProvider.sourcePlaylistId);

    final result = await showAppContextMenu<_BatchActionMenuResult>(
      context,
      anchorContext: anchorContext,
      alignRightToAnchor: true,
      width: 320,
      estimatedHeight: canRemoveFromPlaylist
          ? 360
          : (isAuthenticated ? 320 : 220),
      menuBuilder: (menuContext, close) => Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          AppMenuSectionLabel('批量操作 · 已选 ${selectionProvider.selectedCount} 首'),
          if (isAuthenticated)
            _buildBatchMenuItem(
              menuContext,
              icon: CupertinoIcons.add_circled,
              title: '添加到歌单',
              subtitle: '将选中的歌曲添加到您的收藏歌单',
              onTap: () => close(_BatchActionMenuResult.addToPlaylist),
            ),
          if (canRemoveFromPlaylist)
            _buildBatchMenuItem(
              menuContext,
              icon: CupertinoIcons.trash,
              title: '从本歌单删除',
              subtitle: '将选中的歌曲从当前歌单中移除',
              onTap: () => close(_BatchActionMenuResult.removeFromPlaylist),
              isDestructive: true,
            ),
          _buildBatchMenuItem(
            menuContext,
            icon: CupertinoIcons.play_circle,
            title: '立即播放',
            subtitle: '替换当前播放列表并开始播放',
            onTap: () => close(_BatchActionMenuResult.playNow),
          ),
          if (isAuthenticated)
            _buildBatchMenuItem(
              menuContext,
              icon: CupertinoIcons.heart_fill,
              title: '添加到喜欢',
              subtitle: '收藏到“我喜欢的音乐”',
              onTap: () => close(_BatchActionMenuResult.addToFavorite),
            ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
            child: Divider(
              height: 1,
              color: Theme.of(menuContext)
                  .colorScheme
                  .outlineVariant
                  .withAlpha(120),
            ),
          ),
          _buildBatchMenuItem(
            menuContext,
            icon: CupertinoIcons.multiply_circle,
            title: '取消选择',
            subtitle: '退出批量操作模式',
            onTap: () => close(_BatchActionMenuResult.cancelSelection),
            isDestructive: true,
          ),
        ],
      ),
    );

    if (!context.mounted || result == null) return;

    switch (result) {
      case _BatchActionMenuResult.addToPlaylist:
        await _addSelectedToPlaylist(context, selectionProvider);
        break;
      case _BatchActionMenuResult.removeFromPlaylist:
        final songs = selectionProvider.selectedSongs;
        final count = await userProvider.removeSongsFromPlaylist(
          selectionProvider.sourcePlaylistId,
          songs,
        );
        if (!context.mounted) return;
        selectionProvider.exitSelectionMode();
        if (count > 0) {
          CustomToast.success(context, '已从歌单中删除 $count 首歌曲');
        } else {
          CustomToast.error(context, '删除失败');
        }
        break;
      case _BatchActionMenuResult.playNow:
        selectionProvider.exitSelectionMode();
        _playSongs(context, selectionProvider.selectedSongs);
        break;
      case _BatchActionMenuResult.addToFavorite:
        await _addSelectedToFavorite(context, selectionProvider);
        break;
      case _BatchActionMenuResult.cancelSelection:
        selectionProvider.exitSelectionMode();
        break;
    }
  }

  Widget _buildBatchMenuItem(
    BuildContext context, {
    required IconData icon,
    required String title,
    required String subtitle,
    required VoidCallback onTap,
    bool isDestructive = false,
  }) {
    final theme = Theme.of(context);

    return AppMenuItemButton(
      leading: Container(
        width: 38,
        height: 38,
        decoration: BoxDecoration(
          color: (isDestructive
                  ? theme.colorScheme.error
                  : theme.colorScheme.primary)
              .withAlpha(16),
          borderRadius: BorderRadius.circular(12),
        ),
        child: Icon(
          icon,
          size: 18,
          color: isDestructive
              ? theme.colorScheme.error
              : theme.colorScheme.primary,
        ),
      ),
      title: Text(
        title,
        style: TextStyle(
          fontSize: 14,
          fontWeight: AppTheme.fontWeightSemiBold,
          color: isDestructive
              ? theme.colorScheme.error
              : theme.colorScheme.onSurface,
        ),
      ),
      subtitle: Text(
        subtitle,
        style: TextStyle(
          fontSize: 11,
          fontWeight: AppTheme.fontWeightSemiBold,
          color: theme.colorScheme.onSurfaceVariant,
        ),
      ),
      trailing: Icon(
        CupertinoIcons.chevron_right,
        size: 13,
        color: theme.colorScheme.onSurfaceVariant,
      ),
      isDestructive: isDestructive,
      showCheckmark: false,
      onPressed: onTap,
    );
  }

  Future<void> _addSelectedToPlaylist(
    BuildContext context,
    SelectionProvider selectionProvider,
  ) async {
    final userProvider = context.read<UserProvider>();
    final myPlaylists = userProvider.createdPlaylists;

    if (myPlaylists.isEmpty) {
      CustomToast.warning(context, '您还没有创建任何歌单');
      return;
    }

    final playlist = await showPlaylistPickerDialog(
      context,
      playlists: myPlaylists,
    );
    if (playlist == null || !context.mounted) return;

    final count = await userProvider.addSongsToPlaylist(
      playlist['listid'] ?? playlist['specialid'],
      selectionProvider.selectedSongs,
    );
    if (!context.mounted) return;

    selectionProvider.exitSelectionMode();
    if (count > 0) {
      CustomToast.success(context, '成功添加 $count 首歌曲到歌单');
    } else {
      CustomToast.error(context, '添加失败');
    }
  }

  Future<void> _addSelectedToFavorite(
    BuildContext context,
    SelectionProvider selectionProvider,
  ) async {
    final persistenceProvider = context.read<PersistenceProvider>();
    final userProvider = context.read<UserProvider>();
    final songs = selectionProvider.selectedSongs;

    for (final song in songs) {
      if (!persistenceProvider.isFavorite(song)) {
        await persistenceProvider.toggleFavorite(song, userProvider: userProvider);
      }
    }

    if (!context.mounted) return;
    selectionProvider.exitSelectionMode();
    CustomToast.success(context, '已添加 ${songs.length} 首歌曲到我喜欢的');
  }
}
