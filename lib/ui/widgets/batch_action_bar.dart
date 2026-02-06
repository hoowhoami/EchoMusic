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
                borderRadius: BorderRadius.circular(24),
                child: BackdropFilter(
                  filter: ImageFilter.blur(sigmaX: 20, sigmaY: 20),
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 16),
                    decoration: BoxDecoration(
                      color: theme.colorScheme.surface.withAlpha(theme.brightness == Brightness.dark ? 200 : 230),
                      borderRadius: BorderRadius.circular(24),
                      border: Border.all(
                        color: theme.colorScheme.primary.withAlpha(50),
                        width: 1.0,
                      ),
                      boxShadow: [
                        BoxShadow(
                          color: Colors.black.withAlpha(30),
                          blurRadius: 30,
                          offset: const Offset(0, 12),
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
                                fontWeight: FontWeight.w700,
                                color: theme.colorScheme.onSurface.withAlpha(120),
                              ),
                            ),
                            Text(
                              '${selectionProvider.selectedCount} 首歌曲',
                              style: TextStyle(
                                fontSize: 16,
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
    final isEnabled = onPressed != null;

    return MouseRegion(
      cursor: isEnabled ? SystemMouseCursors.click : SystemMouseCursors.basic,
      onEnter: (_) => setState(() => _hoveredButton = id),
      onExit: (_) => setState(() => _hoveredButton = null),
      child: CupertinoButton(
        padding: const EdgeInsets.symmetric(horizontal: 12),
        onPressed: onPressed,
        minSize: 0,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            AnimatedContainer(
              duration: const Duration(milliseconds: 200),
              padding: const EdgeInsets.all(8),
              decoration: BoxDecoration(
                color: isHovered 
                  ? (isDestructive ? theme.colorScheme.error.withAlpha(200) : theme.colorScheme.primary)
                  : (isEnabled 
                      ? (isDestructive ? theme.colorScheme.error.withAlpha(30) : theme.colorScheme.primary.withAlpha(30))
                      : theme.disabledColor.withAlpha(20)),
                shape: BoxShape.circle,
              ),
              child: Padding(
                padding: EdgeInsets.only(left: icon == CupertinoIcons.play_fill ? 2 : 0),
                child: Icon(
                  icon,
                  size: 18,
                  color: isHovered 
                    ? Colors.white 
                    : (isEnabled 
                        ? (isDestructive ? theme.colorScheme.error : theme.colorScheme.primary)
                        : theme.colorScheme.onSurface.withAlpha(40)),
                ),
              ),
            ),
            const SizedBox(height: 6),
            Text(
              label,
              style: TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.w800,
                color: isEnabled 
                  ? (isDestructive ? theme.colorScheme.error.withAlpha(200) : theme.colorScheme.onSurface.withAlpha(200))
                  : theme.colorScheme.onSurface.withAlpha(40),
              ),
            ),
          ],
        ),
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

  void _showBatchActions(BuildContext context, SelectionProvider selectionProvider) {
    final theme = Theme.of(context);
    final userProvider = context.read<UserProvider>();
    final isAuthenticated = userProvider.isAuthenticated;

    showCupertinoModalPopup(
      context: context,
      builder: (context) => Center(
        child: Container(
          constraints: const BoxConstraints(maxWidth: 400),
          margin: const EdgeInsets.all(24),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(32),
            child: BackdropFilter(
              filter: ImageFilter.blur(sigmaX: 40, sigmaY: 40),
              child: Container(
                decoration: BoxDecoration(
                  color: theme.colorScheme.surface.withAlpha(theme.brightness == Brightness.dark ? 200 : 240),
                  borderRadius: BorderRadius.circular(32),
                  border: Border.all(
                    color: theme.colorScheme.onSurface.withAlpha(30),
                    width: 0.5,
                  ),
                  boxShadow: [
                    BoxShadow(
                      color: Colors.black.withAlpha(50),
                      blurRadius: 50,
                      offset: const Offset(0, 20),
                    ),
                  ],
                ),
                child: Material(
                  color: Colors.transparent,
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Container(
                        width: 40,
                        height: 4,
                        margin: const EdgeInsets.symmetric(vertical: 12),
                        decoration: BoxDecoration(
                          color: theme.colorScheme.onSurface.withAlpha(40),
                          borderRadius: BorderRadius.circular(2),
                        ),
                      ),
                      Padding(
                        padding: const EdgeInsets.fromLTRB(24, 8, 24, 16),
                        child: Row(
                          children: [
                            Container(
                              padding: const EdgeInsets.all(10),
                              decoration: BoxDecoration(
                                color: theme.colorScheme.primary.withAlpha(30),
                                borderRadius: BorderRadius.circular(12),
                              ),
                              child: Icon(
                                CupertinoIcons.layers_alt_fill,
                                size: 18,
                                color: theme.colorScheme.primary,
                              ),
                            ),
                            const SizedBox(width: 16),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    '批量操作',
                                    style: TextStyle(
                                      fontSize: 18,
                                      fontWeight: FontWeight.w900,
                                      color: theme.colorScheme.onSurface,
                                      letterSpacing: -0.5,
                                    ),
                                  ),
                                  Text(
                                    '已选择 ${selectionProvider.selectedCount} 首歌曲',
                                    style: TextStyle(
                                      fontSize: 12,
                                      fontWeight: FontWeight.w600,
                                      color: theme.colorScheme.onSurfaceVariant,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                      ),
                      Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 12),
                        child: Column(
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
                                },
                              ),
                            const SizedBox(height: 8),
                            const Divider(height: 1),
                            const SizedBox(height: 8),
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
                      const SizedBox(height: 24),
                    ],
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

    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        mouseCursor: SystemMouseCursors.click,
        borderRadius: BorderRadius.circular(20),
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
                  borderRadius: BorderRadius.circular(14),
                ),
                child: Icon(
                  icon,
                  size: 24,
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
                        fontWeight: FontWeight.w800,
                        color: isDestructive ? theme.colorScheme.error : theme.colorScheme.onSurface,
                      ),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      subtitle,
                      style: TextStyle(
                        fontSize: 12,
                        color: theme.colorScheme.onSurfaceVariant.withAlpha(180),
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
    );
  }

  void _showAddToPlaylistDialog(BuildContext context, SelectionProvider selectionProvider) {
    final theme = Theme.of(context);
    final userProvider = context.read<UserProvider>();
    final myPlaylists = userProvider.userPlaylists
        .where((p) => p['list_create_userid'] == userProvider.user?.userid)
        .toList();

    showCupertinoModalPopup(
      context: context,
      builder: (context) => Center(
        child: Container(
          constraints: const BoxConstraints(maxWidth: 420, maxHeight: 600),
          margin: const EdgeInsets.all(24),
          child: ClipRRect(
            borderRadius: BorderRadius.circular(32),
            child: BackdropFilter(
              filter: ImageFilter.blur(sigmaX: 40, sigmaY: 40),
              child: Container(
                decoration: BoxDecoration(
                  color: theme.colorScheme.surface.withAlpha(theme.brightness == Brightness.dark ? 200 : 240),
                  borderRadius: BorderRadius.circular(32),
                  border: Border.all(
                    color: theme.colorScheme.onSurface.withAlpha(30),
                    width: 0.5,
                  ),
                  boxShadow: [
                    BoxShadow(
                      color: Colors.black.withAlpha(50),
                      blurRadius: 50,
                      offset: const Offset(0, 20),
                    ),
                  ],
                ),
                child: Material(
                  color: Colors.transparent,
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Container(
                        width: 40,
                        height: 4,
                        margin: const EdgeInsets.symmetric(vertical: 12),
                        decoration: BoxDecoration(
                          color: theme.colorScheme.onSurface.withAlpha(40),
                          borderRadius: BorderRadius.circular(2),
                        ),
                      ),
                      Padding(
                        padding: const EdgeInsets.fromLTRB(24, 8, 24, 16),
                        child: Row(
                          children: [
                            Container(
                              padding: const EdgeInsets.all(10),
                              decoration: BoxDecoration(
                                color: theme.colorScheme.primary.withAlpha(30),
                                borderRadius: BorderRadius.circular(12),
                              ),
                              child: Icon(
                                CupertinoIcons.music_note_list,
                                size: 18,
                                color: theme.colorScheme.primary,
                              ),
                            ),
                            const SizedBox(width: 16),
                            Expanded(
                              child: Text(
                                '添加到歌单',
                                style: TextStyle(
                                  fontSize: 18,
                                  fontWeight: FontWeight.w900,
                                  color: theme.colorScheme.onSurface,
                                  letterSpacing: -0.5,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                      Flexible(
                        child: ListView.builder(
                          shrinkWrap: true,
                          padding: const EdgeInsets.symmetric(horizontal: 12),
                          itemCount: myPlaylists.length,
                          itemBuilder: (context, index) {
                            final p = myPlaylists[index];
                            return InkWell(
                              onTap: () async {
                                Navigator.pop(context);
                                final songs = selectionProvider.selectedSongs;
                                await userProvider.addSongsToPlaylist(p['listid'] ?? p['specialid'], songs);
                                selectionProvider.exitSelectionMode();
                              },
                              mouseCursor: SystemMouseCursors.click,
                              borderRadius: BorderRadius.circular(20),
                              child: Padding(
                                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
                                child: Row(
                                  children: [
                                    Container(
                                      width: 48,
                                      height: 48,
                                      decoration: BoxDecoration(
                                        color: theme.colorScheme.primary.withAlpha(20),
                                        borderRadius: BorderRadius.circular(14),
                                      ),
                                      child: Icon(
                                        CupertinoIcons.music_note_list,
                                        color: theme.colorScheme.primary,
                                        size: 20,
                                      ),
                                    ),
                                    const SizedBox(width: 16),
                                    Expanded(
                                      child: Column(
                                        crossAxisAlignment: CrossAxisAlignment.start,
                                        children: [
                                          Text(
                                            p['name'] ?? p['specialname'] ?? '',
                                            style: TextStyle(
                                              fontSize: 15,
                                              fontWeight: FontWeight.w700,
                                              color: theme.colorScheme.onSurface,
                                            ),
                                            maxLines: 1,
                                            overflow: TextOverflow.ellipsis,
                                          ),
                                          const SizedBox(height: 2),
                                          Text(
                                            '${p['song_count'] ?? 0} 首歌曲',
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
                            );
                          },
                        ),
                      ),
                      const SizedBox(height: 24),
                    ],
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