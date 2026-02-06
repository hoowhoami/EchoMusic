import 'dart:ui';
import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import '../../providers/selection_provider.dart';
import '../../providers/user_provider.dart';
import '../../providers/audio_provider.dart';
import '../../providers/persistence_provider.dart';
import '../../theme/app_theme.dart';

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
        return child!;
      },
      child: FadeTransition(
        opacity: _animation,
        child: ScaleTransition(
          scale: _animation,
          child: Padding(
            padding: const EdgeInsets.only(bottom: 24),
            child: Align(
              alignment: Alignment.bottomCenter,
              child: ClipRRect(
                borderRadius: BorderRadius.circular(20),
                child: BackdropFilter(
                  filter: ImageFilter.blur(sigmaX: 15, sigmaY: 15),
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 14),
                    decoration: BoxDecoration(
                      color: modernTheme.batchBarColor,
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
                                fontWeight: FontWeight.w600,
                                color: theme.colorScheme.onSurface.withAlpha(120),
                              ),
                            ),
                            Text(
                              '${selectionProvider.selectedCount} 首歌曲',
                              style: TextStyle(
                                fontSize: 15,
                                fontWeight: FontWeight.w900,
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
                        _buildIconButton(
                          icon: CupertinoIcons.add,
                          label: '添加',
                          onPressed: selectionProvider.hasSelection ? () => _showBatchActions(context, selectionProvider) : null,
                          id: 'add',
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
              ),
            ),
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
                fontWeight: FontWeight.w700,
                color: isDestructive ? theme.colorScheme.error.withAlpha(200) : theme.colorScheme.onSurface.withAlpha(180),
              ),
            ),
          ],
        ), minimumSize: Size(0, 0),
      ),
    );
  }

  void _playSelected(BuildContext context, SelectionProvider selectionProvider) {
    selectionProvider.exitSelectionMode();
    final songs = selectionProvider.selectedSongs;
    if (songs.isNotEmpty) {
      context.read<AudioProvider>().playSong(songs.first, playlist: songs);
    }
  }

  Widget _buildTextButton({
    required String label,
    required VoidCallback? onPressed,
    required Color color,
    required String id,
  }) {
    final theme = Theme.of(context);
    final isHovered = _hoveredButton == id && onPressed != null;

    return MouseRegion(
      cursor: onPressed != null ? SystemMouseCursors.click : SystemMouseCursors.basic,
      onEnter: (_) => setState(() => _hoveredButton = id),
      onExit: (_) => setState(() => _hoveredButton = null),
      child: CupertinoButton(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        onPressed: onPressed,
        child: AnimatedDefaultTextStyle(
          duration: const Duration(milliseconds: 200),
          style: TextStyle(
            fontSize: 14,
            fontWeight: FontWeight.w700,
            color: onPressed != null
                ? (isHovered ? color : color.withValues(alpha: 0.7))
                : theme.colorScheme.onSurface.withValues(alpha: 0.3),
          ),
          child: Text(label),
        ),
      ),
    );
  }

  Widget _buildActionButton(
    BuildContext context, {
    required VoidCallback? onPressed,
    required String id,
  }) {
    final theme = Theme.of(context);
    final isHovered = _hoveredButton == id && onPressed != null;

    return MouseRegion(
      cursor: onPressed != null ? SystemMouseCursors.click : SystemMouseCursors.basic,
      onEnter: (_) => setState(() => _hoveredButton = id),
      onExit: (_) => setState(() => _hoveredButton = null),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 200),
        decoration: BoxDecoration(
          color: onPressed != null
              ? (isHovered ? theme.colorScheme.primary : theme.colorScheme.primary.withValues(alpha: 0.85))
              : theme.colorScheme.onSurface.withValues(alpha: 0.1),
          borderRadius: BorderRadius.circular(10),
          boxShadow: isHovered
              ? [BoxShadow(color: theme.colorScheme.primary.withValues(alpha: 0.3), blurRadius: 8, offset: const Offset(0, 2))]
              : [],
        ),
        child: CupertinoButton(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          onPressed: onPressed,
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(
                CupertinoIcons.ellipsis,
                size: 16,
                color: onPressed != null ? theme.colorScheme.onPrimary : theme.colorScheme.onSurface.withValues(alpha: 0.3),
              ),
              const SizedBox(width: 8),
              Text(
                '批量操作',
                style: TextStyle(
                  color: onPressed != null ? theme.colorScheme.onPrimary : theme.colorScheme.onSurface.withValues(alpha: 0.3),
                  fontSize: 14,
                  fontWeight: FontWeight.w800,
                ),
              ),
            ],
          ), minimumSize: Size(0, 0),
        ),
      ),
    );
  }

  int _getAvailableSongCount(SelectionProvider provider) {
    return provider.currentSongList.length;
  }

  void _showBatchActions(BuildContext context, SelectionProvider selectionProvider) {
    final theme = Theme.of(context);
    final modernTheme = theme.extension<AppModernTheme>()!;
    final userProvider = context.read<UserProvider>();
    final isAuthenticated = userProvider.isAuthenticated;

    showGeneralDialog(
      context: context,
      barrierDismissible: true,
      barrierLabel: 'BatchActions',
      barrierColor: Colors.black.withAlpha(40),
      transitionDuration: const Duration(milliseconds: 300),
      pageBuilder: (context, animation, secondaryAnimation) => Center(
        child: ScaleTransition(
          scale: CurvedAnimation(parent: animation, curve: Curves.easeOutBack),
          child: FadeTransition(
            opacity: animation,
            child: Container(
              constraints: const BoxConstraints(maxWidth: 400),
              margin: const EdgeInsets.all(24),
              child: ClipRRect(
                borderRadius: BorderRadius.circular(28),
                child: BackdropFilter(
                  filter: ImageFilter.blur(sigmaX: 20, sigmaY: 20),
                  child: Container(
                    decoration: BoxDecoration(
                      color: modernTheme.modalColor,
                      borderRadius: BorderRadius.circular(28),
                      border: Border.all(
                        color: theme.colorScheme.primary.withAlpha(30),
                        width: 1.0,
                      ),
                      boxShadow: [
                        BoxShadow(
                          color: Colors.black.withAlpha(30),
                          blurRadius: 30,
                          offset: const Offset(0, 10),
                        ),
                      ],
                    ),
                    child: Material(
                      color: Colors.transparent,
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
                                color: theme.colorScheme.onSurface.withAlpha(40),
                                borderRadius: BorderRadius.circular(2),
                              ),
                            ),
                            Padding(
                              padding: const EdgeInsets.fromLTRB(20, 4, 20, 12),
                              child: Row(
                                children: [
                                  Container(
                                    padding: const EdgeInsets.all(8),
                                    decoration: BoxDecoration(
                                      color: theme.colorScheme.primary.withAlpha(30),
                                      borderRadius: BorderRadius.circular(10),
                                    ),
                                    child: Icon(
                                      CupertinoIcons.layers_alt_fill,
                                      size: 16,
                                      color: theme.colorScheme.primary,
                                    ),
                                  ),
                                  const SizedBox(width: 12),
                                  Expanded(
                                    child: Column(
                                      crossAxisAlignment: CrossAxisAlignment.start,
                                      children: [
                                        Text(
                                          '批量操作',
                                          style: TextStyle(
                                            fontSize: 16,
                                            fontWeight: FontWeight.w900,
                                            color: theme.colorScheme.onSurface,
                                            letterSpacing: -0.5,
                                          ),
                                        ),
                                        Text(
                                          '已选择 ${selectionProvider.selectedCount} 首歌曲',
                                          style: TextStyle(
                                            fontSize: 11,
                                            fontWeight: FontWeight.w600,
                                            color: theme.colorScheme.onSurfaceVariant,
                                          ),
                                        ),
                                      ],
                                    ),
                                  ),
                                  CupertinoButton(
                                    padding: EdgeInsets.zero,
                                    onPressed: () => Navigator.pop(context),
                                    child: Container(
                                      padding: const EdgeInsets.all(6),
                                      decoration: BoxDecoration(
                                        color: theme.colorScheme.onSurface.withAlpha(20),
                                        shape: BoxShape.circle,
                                      ),
                                      child: Icon(
                                        CupertinoIcons.xmark,
                                        size: 14,
                                        color: theme.colorScheme.onSurfaceVariant,
                                      ),
                                    ),
                                  ),
                                ],
                              ),
                            ),
                            Padding(
                              padding: const EdgeInsets.symmetric(horizontal: 8),
                              child: ListView(
                                shrinkWrap: true,
                                padding: const EdgeInsets.only(bottom: 12),
                                physics: const NeverScrollableScrollPhysics(),
                                children: [
                                  if (isAuthenticated)
                                    _buildImprovedActionItem(
                                      context,
                                      icon: CupertinoIcons.add_circled,
                                      title: '添加到歌单',
                                      subtitle: '将选中的歌曲添加到您的收藏歌单',
                                      onTap: () {
                                        Navigator.pop(context);
                                        _showAddToPlaylistDialog(context, selectionProvider);
                                      },
                                    ),
                                  _buildImprovedActionItem(
                                    context,
                                    icon: CupertinoIcons.play_circle,
                                    title: '立即播放',
                                    subtitle: '替换当前播放列表并开始播放',
                                    onTap: () {
                                      Navigator.pop(context);
                                      selectionProvider.exitSelectionMode();
                                      final songs = selectionProvider.selectedSongs;
                                      if (songs.isNotEmpty) {
                                        context.read<AudioProvider>().playSong(songs.first, playlist: songs);
                                      }
                                    },
                                  ),
                                  if (isAuthenticated)
                                    _buildImprovedActionItem(
                                      context,
                                      icon: CupertinoIcons.heart_fill,
                                      title: '添加到喜欢',
                                      subtitle: '收藏到“我喜欢的音乐”',
                                      onTap: () async {
                                        Navigator.pop(context);
                                        final persistenceProvider = context.read<PersistenceProvider>();
                                        final songs = selectionProvider.selectedSongs;
                                        for (final song in songs) {
                                          await persistenceProvider.toggleFavorite(song);
                                        }
                                        selectionProvider.exitSelectionMode();
                                        if (context.mounted) {
                                          ScaffoldMessenger.of(context).showSnackBar(
                                            SnackBar(
                                              content: Text('已添加 ${songs.length} 首歌曲到我喜欢的'),
                                              behavior: SnackBarBehavior.floating,
                                              margin: const EdgeInsets.all(20),
                                              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                                            ),
                                          );
                                        }
                                      },
                                    ),
                                  const Padding(
                                    padding: EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                                    child: Divider(height: 1),
                                  ),
                                  _buildImprovedActionItem(
                                    context,
                                    icon: CupertinoIcons.multiply_circle,
                                    title: '取消选择',
                                    subtitle: '退出批量操作模式',
                                    onTap: () {
                                      Navigator.pop(context);
                                      selectionProvider.exitSelectionMode();
                                    },
                                    isDestructive: true,
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildImprovedActionItem(
    BuildContext context, {
    required IconData icon,
    required String title,
    required String subtitle,
    required VoidCallback onTap,
    bool isDestructive = false,
  }) {
    final theme = Theme.of(context);

    return Container(
      margin: const EdgeInsets.symmetric(vertical: 4),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(16),
          hoverColor: isDestructive 
            ? theme.colorScheme.error.withAlpha(20) 
            : theme.colorScheme.primary.withAlpha(20),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            child: Row(
              children: [
                Container(
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: isDestructive
                        ? theme.colorScheme.error.withAlpha(30)
                        : theme.colorScheme.primary.withAlpha(20),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Icon(
                    icon,
                    size: 22,
                    color: isDestructive
                        ? theme.colorScheme.error
                        : theme.colorScheme.primary,
                  ),
                ),
                const SizedBox(width: 16),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        title,
                        style: TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w700,
                          color: isDestructive ? theme.colorScheme.error : theme.colorScheme.onSurface,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        subtitle,
                        style: TextStyle(
                          fontSize: 12,
                          color: theme.colorScheme.onSurfaceVariant,
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                    ],
                  ),
                ),
                Icon(
                  CupertinoIcons.chevron_right,
                  size: 14,
                  color: theme.colorScheme.onSurface.withAlpha(40),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  void _showAddToPlaylistDialog(BuildContext context, SelectionProvider selectionProvider) {
    final theme = Theme.of(context);
    final modernTheme = theme.extension<AppModernTheme>()!;
    final userProvider = context.read<UserProvider>();
    final myPlaylists = userProvider.userPlaylists
        .where((p) => p['list_create_userid'] == userProvider.user?.userid)
        .toList();

    if (myPlaylists.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('您还没有创建任何歌单')),
      );
      return;
    }

    showGeneralDialog(
      context: context,
      barrierDismissible: true,
      barrierLabel: 'AddToPlaylist',
      barrierColor: Colors.black.withAlpha(40),
      transitionDuration: const Duration(milliseconds: 300),
      pageBuilder: (context, animation, secondaryAnimation) => Center(
        child: ScaleTransition(
          scale: CurvedAnimation(parent: animation, curve: Curves.easeOutBack),
          child: FadeTransition(
            opacity: animation,
            child: Container(
              constraints: const BoxConstraints(maxWidth: 420, maxHeight: 550),
              margin: const EdgeInsets.all(24),
              child: ClipRRect(
                borderRadius: BorderRadius.circular(28),
                child: BackdropFilter(
                  filter: ImageFilter.blur(sigmaX: 20, sigmaY: 20),
                  child: Container(
                    decoration: BoxDecoration(
                      color: modernTheme.modalColor,
                      borderRadius: BorderRadius.circular(28),
                      border: Border.all(
                        color: theme.colorScheme.primary.withAlpha(30),
                        width: 1.0,
                      ),
                      boxShadow: [
                        BoxShadow(
                          color: Colors.black.withAlpha(30),
                          blurRadius: 30,
                          offset: const Offset(0, 10),
                        ),
                      ],
                    ),
                    child: Material(
                      color: Colors.transparent,
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Container(
                            width: 36,
                            height: 4,
                            margin: const EdgeInsets.symmetric(vertical: 12),
                            decoration: BoxDecoration(
                              color: theme.colorScheme.onSurface.withAlpha(40),
                              borderRadius: BorderRadius.circular(2),
                            ),
                          ),
                          Padding(
                            padding: const EdgeInsets.fromLTRB(20, 4, 20, 12),
                            child: Row(
                              children: [
                                Container(
                                  padding: const EdgeInsets.all(8),
                                  decoration: BoxDecoration(
                                    color: theme.colorScheme.primary.withAlpha(30),
                                    borderRadius: BorderRadius.circular(10),
                                  ),
                                  child: Icon(
                                    CupertinoIcons.music_note_list,
                                    size: 16,
                                    color: theme.colorScheme.primary,
                                  ),
                                ),
                                const SizedBox(width: 12),
                                Expanded(
                                  child: Text(
                                    '添加到歌单',
                                    style: TextStyle(
                                      fontSize: 16,
                                      fontWeight: FontWeight.w900,
                                      color: theme.colorScheme.onSurface,
                                      letterSpacing: -0.5,
                                    ),
                                  ),
                                ),
                                CupertinoButton(
                                  padding: EdgeInsets.zero,
                                  onPressed: () => Navigator.pop(context),
                                  child: Container(
                                    padding: const EdgeInsets.all(6),
                                    decoration: BoxDecoration(
                                      color: theme.colorScheme.onSurface.withAlpha(20),
                                      shape: BoxShape.circle,
                                    ),
                                    child: Icon(
                                      CupertinoIcons.xmark,
                                      size: 14,
                                      color: theme.colorScheme.onSurfaceVariant,
                                    ),
                                  ),
                                ),
                              ],
                            ),
                          ),
                          Flexible(
                            child: ListView.builder(
                              shrinkWrap: true,
                              padding: const EdgeInsets.symmetric(horizontal: 8),
                              itemCount: myPlaylists.length,
                              itemBuilder: (context, index) {
                                final p = myPlaylists[index];
                                return Container(
                                  margin: const EdgeInsets.symmetric(vertical: 2),
                                  child: InkWell(
                                    onTap: () async {
                                      Navigator.pop(context);
                                      final songs = selectionProvider.selectedSongs;
                                      final count = await userProvider.addSongsToPlaylist(p['listid'] ?? p['specialid'], songs);
                                      selectionProvider.exitSelectionMode();
                                      if (context.mounted) {
                                        ScaffoldMessenger.of(context).showSnackBar(
                                          SnackBar(
                                            content: Text('成功添加 $count 首歌曲到歌单'),
                                            behavior: SnackBarBehavior.floating,
                                            margin: const EdgeInsets.all(20),
                                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                                          ),
                                        );
                                      }
                                    },
                                    borderRadius: BorderRadius.circular(16),
                                    hoverColor: theme.colorScheme.primary.withAlpha(20),
                                    child: Padding(
                                      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                                      child: Row(
                                        children: [
                                          Container(
                                            width: 44,
                                            height: 44,
                                            decoration: BoxDecoration(
                                              color: theme.colorScheme.primary.withAlpha(20),
                                              borderRadius: BorderRadius.circular(12),
                                            ),
                                            child: Icon(
                                              CupertinoIcons.music_note_list,
                                              color: theme.colorScheme.primary,
                                              size: 18,
                                            ),
                                          ),
                                          const SizedBox(width: 12),
                                          Expanded(
                                            child: Column(
                                              crossAxisAlignment: CrossAxisAlignment.start,
                                              children: [
                                                Text(
                                                  p['name'] ?? p['specialname'] ?? '',
                                                  style: TextStyle(
                                                    fontSize: 14,
                                                    fontWeight: FontWeight.w700,
                                                    color: theme.colorScheme.onSurface,
                                                  ),
                                                  maxLines: 1,
                                                  overflow: TextOverflow.ellipsis,
                                                ),
                                                const SizedBox(height: 1),
                                                Text(
                                                  '${p['song_count'] ?? 0} 首歌曲',
                                                  style: TextStyle(
                                                    fontSize: 11,
                                                    color: theme.colorScheme.onSurfaceVariant,
                                                    fontWeight: FontWeight.w500,
                                                  ),
                                                ),
                                              ],
                                            ),
                                          ),
                                          Icon(
                                            CupertinoIcons.chevron_right,
                                            size: 12,
                                            color: theme.colorScheme.onSurface.withAlpha(40),
                                          ),
                                        ],
                                      ),
                                    ),
                                  ),
                                );
                              },
                            ),
                          ),
                          const SizedBox(height: 12),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
