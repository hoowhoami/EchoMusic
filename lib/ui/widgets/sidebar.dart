import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import 'package:echomusic/providers/user_provider.dart';
import 'package:echomusic/providers/navigation_provider.dart';
import '../screens/login_screen.dart';
import '../../models/playlist.dart';
import 'cover_image.dart';
import 'custom_dialog.dart';
import 'custom_toast.dart';

class Sidebar extends StatelessWidget {
  final int selectedIndex;
  final dynamic selectedPlaylistId;
  final ValueChanged<int> onDestinationSelected;
  final void Function(Playlist)? onPushPlaylist;

  const Sidebar({
    super.key,
    required this.selectedIndex,
    this.selectedPlaylistId,
    required this.onDestinationSelected,
    this.onPushPlaylist,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final user = context.select<UserProvider, dynamic>((p) => p.user);
    final isAuthenticated = context.select<UserProvider, bool>((p) => p.isAuthenticated);
    final accentColor = theme.colorScheme.primary;

    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 10),
          child: Container(
            padding: const EdgeInsets.all(4),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(20),
              color: theme.colorScheme.onSurface.withAlpha(10),
              border: Border.all(color: theme.colorScheme.outlineVariant.withAlpha(80), width: 1),
            ),
            child: Row(
              children: [
                Expanded(child: _buildTopProfileItem(context, isAuthenticated, user, theme, accentColor)),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 10),
                  child: Container(height: 22, width: 1, color: theme.colorScheme.onSurface.withAlpha(40)),
                ),
                _buildSettingsIconButton(context, 5, onDestinationSelected, theme, accentColor),
              ],
            ),
          ),
        ),
        Expanded(
          child: Transform.translate(
            offset: const Offset(0, -12),
            child: SingleChildScrollView(
              physics: const BouncingScrollPhysics(),
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _buildGroupTitle(context, '发现音乐'),
                  _buildNavItem(context, 0, CupertinoIcons.rocket_fill, '为您推荐'),
                  _buildNavItem(context, 1, CupertinoIcons.compass_fill, '探索发现'),
                  _buildNavItem(context, 2, CupertinoIcons.search, '全网搜索'),
                  const SizedBox(height: 18),
                  _buildGroupTitle(context, '我的乐库'),
                  _buildNavItem(context, 3, CupertinoIcons.clock_fill, '播放历史'),
                  _buildNavItem(context, 4, CupertinoIcons.cloud_fill, '我的云盘'),
                  const SizedBox(height: 18),
                  _buildPlaylistSection(context),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildTopProfileItem(BuildContext context, bool isAuthenticated, dynamic user, ThemeData theme, Color accentColor) {
    final isSelected = selectedPlaylistId == null && selectedIndex == 6;
    return _TopItemWithHover(
      isSelected: isSelected,
      accentColor: accentColor,
      onTap: () {
        if (!isAuthenticated) {
          Navigator.push(context, CupertinoPageRoute(builder: (_) => const LoginScreen()));
        } else {
          onDestinationSelected(6);
        }
      },
      child: Row(
        children: [
          ClipOval(child: user?.pic != null ? CoverImage(url: user!.pic!, width: 34, height: 34, borderRadius: 0, showShadow: false, size: 100) : Container(width: 34, height: 34, color: accentColor.withAlpha(20), child: Icon(CupertinoIcons.person_fill, color: accentColor, size: 18))),
          const SizedBox(width: 12),
          Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [Text(user?.nickname ?? '未登录', style: TextStyle(color: isSelected ? accentColor : theme.colorScheme.onSurface, fontWeight: FontWeight.w900, fontSize: 13, letterSpacing: -0.4), maxLines: 1, overflow: TextOverflow.ellipsis), Text(isAuthenticated ? 'Lv.${user?.extendsInfo?['detail']?['p_grade'] ?? 0}' : '点击登录账号', style: TextStyle(color: isSelected ? accentColor.withAlpha(180) : theme.colorScheme.onSurfaceVariant, fontSize: 9, fontWeight: FontWeight.w800, letterSpacing: 0.2))])),
        ],
      ),
    );
  }

  Widget _buildSettingsIconButton(BuildContext context, int index, ValueChanged<int> onTap, ThemeData theme, Color accentColor) {
    final isSelected = selectedPlaylistId == null && selectedIndex == index;
    return _TopItemWithHover(
      isSelected: isSelected,
      accentColor: accentColor,
      onTap: () => onTap(index),
      child: Icon(CupertinoIcons.settings_solid, color: isSelected ? accentColor : theme.colorScheme.onSurfaceVariant, size: 20),
    );
  }

  Widget _buildGroupTitle(BuildContext context, String title, {VoidCallback? onAdd}) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(left: 28, right: 25, top: 8, bottom: 10),
      child: Row(
        children: [
          Expanded(
            child: Text(
              title,
              style: TextStyle(
                color: theme.colorScheme.onSurface.withAlpha(120),
                fontSize: 11,
                fontWeight: FontWeight.w900,
                letterSpacing: 1.2,
              ),
            ),
          ),
          if (onAdd != null)
            InkWell(
              onTap: onAdd,
              borderRadius: BorderRadius.circular(6),
              child: Container(
                padding: const EdgeInsets.all(4),
                child: Icon(
                  CupertinoIcons.add,
                  size: 14,
                  color: theme.colorScheme.onSurface.withAlpha(120),
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildPlaylistSection(BuildContext context) {
    final theme = Theme.of(context);
    final isAuthenticated = context.select<UserProvider, bool>((p) => p.isAuthenticated);
    final createdPlaylists = context.select<UserProvider, List<Map<String, dynamic>>>((p) => p.createdPlaylists);
    final favoritedPlaylists = context.select<UserProvider, List<Map<String, dynamic>>>((p) => p.favoritedOnlyPlaylists);
    final favoritedAlbums = context.select<UserProvider, List<Map<String, dynamic>>>((p) => p.favoritedAlbums);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _buildGroupTitle(
          context,
          '自建/收藏歌单',
          onAdd: isAuthenticated ? () => _showCreatePlaylistDialog(context) : null,
        ),
        if (isAuthenticated) ...[
          for (var p in createdPlaylists) _buildPlaylistItem(context, p, CupertinoIcons.music_note_2),
          for (var p in favoritedPlaylists) _buildPlaylistItem(context, p, CupertinoIcons.heart_circle_fill, imageUrl: p['pic']),
          if (favoritedAlbums.isNotEmpty) ...[
            const SizedBox(height: 18),
            _buildGroupTitle(context, '收藏专辑'),
            for (var a in favoritedAlbums) _buildPlaylistItem(context, a, Icons.favorite_rounded, imageUrl: a['pic']),
          ],
        ] else
          Padding(padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 8), child: Text('登录同步云端歌单', style: TextStyle(color: theme.colorScheme.onSurface.withAlpha(80), fontSize: 12, fontWeight: FontWeight.w600, fontStyle: FontStyle.italic))),
      ],
    );
  }

  Widget _buildPlaylistItem(BuildContext context, Map<String, dynamic> playlistData, IconData icon, {String? imageUrl}) {
    final playlist = Playlist.fromUserPlaylist(playlistData);
    final theme = Theme.of(context);
    final isSelected = selectedPlaylistId == playlist.id;
    final accentColor = theme.colorScheme.primary;
    final userProvider = context.read<UserProvider>();
    final isCreatedByUser = playlistData['list_create_userid'] == userProvider.user?.userid;

    // 判断是否可删除：默认歌单不能删除
    final isDefaultPlaylist = playlistData['type'] == 0 && (playlistData['is_def'] == 1 || playlistData['is_def'] == 2);

    final canDelete = !isDefaultPlaylist;

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 1),
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        child: _PlaylistItemWithHover(
          isSelected: isSelected,
          accentColor: accentColor,
          canDelete: canDelete,
          onTap: () {
            if (!isSelected) {
              onPushPlaylist?.call(playlist);
            }
          },
          onDelete: canDelete ? () => _confirmDeletePlaylist(context, playlistData, isCreatedByUser) : null,
          child: Row(
            children: [
              CoverImage(
                url: imageUrl,
                width: 26,
                height: 26,
                borderRadius: 6,
                showShadow: false,
                size: 100,
                errorWidget: Container(
                  decoration: BoxDecoration(
                    color: theme.colorScheme.onSurface.withAlpha(10),
                    borderRadius: BorderRadius.circular(6),
                  ),
                  child: Icon(
                    icon,
                    color: isSelected ? accentColor : theme.colorScheme.onSurfaceVariant,
                    size: 14,
                  ),
                ),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Text(
                  playlist.name,
                  style: TextStyle(
                    color: isSelected ? accentColor : theme.colorScheme.onSurface.withAlpha(220),
                    fontSize: 13,
                    fontWeight: isSelected ? FontWeight.w800 : FontWeight.w700,
                    letterSpacing: -0.2,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  void _confirmDeletePlaylist(BuildContext context, Map<String, dynamic> playlistData, bool isCreatedByUser) async {
    final playlistName = playlistData['name'] ?? '歌单';
    final confirmed = await CustomDialog.show(
      context,
      title: isCreatedByUser ? '删除歌单' : '取消收藏',
      content: '确定要${isCreatedByUser ? '删除' : '取消收藏'}「$playlistName」吗？',
      confirmText: isCreatedByUser ? '删除' : '取消收藏',
      isDestructive: true,
    );

    if (confirmed == true && context.mounted) {
      final userProvider = context.read<UserProvider>();
      final navigationProvider = context.read<NavigationProvider>();
      final listid = playlistData['listid'] ?? playlistData['specialid'];

      if (listid != null) {
        final success = await userProvider.deletePlaylist(listid);
        if (context.mounted) {
          if (success) {
            if (isCreatedByUser) {
              // 删除自建歌单后，直接回到当前根节点，
              // 并清空前进/后退历史，避免回到已失效的详情页。
              navigationProvider.resetToRootAfterPlaylistDeletion();
            }

            CustomToast.success(context, '${isCreatedByUser ? '删除' : '取消收藏'}成功');
          } else {
            CustomToast.error(context, '${isCreatedByUser ? '删除' : '取消收藏'}失败，请重试');
          }
        }
      }
    }
  }

  void _showCreatePlaylistDialog(BuildContext context) {
    final theme = Theme.of(context);
    final nameController = TextEditingController();
    final isPrivateNotifier = ValueNotifier<bool>(false);

    showDialog(
      context: context,
      builder: (context) => CustomDialog(
        title: '新建歌单',
        contentWidget: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            TextField(
              controller: nameController,
              autofocus: true,
              decoration: InputDecoration(
                hintText: '请输入歌单名称',
                hintStyle: TextStyle(
                  color: theme.colorScheme.onSurface.withAlpha(80),
                  fontSize: 14,
                ),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                  borderSide: BorderSide(color: theme.colorScheme.outline),
                ),
                focusedBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(12),
                  borderSide: BorderSide(color: theme.colorScheme.primary, width: 2),
                ),
                contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
              ),
              style: const TextStyle(fontSize: 14),
            ),
            const SizedBox(height: 16),
            ValueListenableBuilder<bool>(
              valueListenable: isPrivateNotifier,
              builder: (context, isPrivate, child) => InkWell(
                onTap: () => isPrivateNotifier.value = !isPrivate,
                borderRadius: BorderRadius.circular(12),
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  child: Row(
                    children: [
                      Icon(
                        isPrivate ? CupertinoIcons.check_mark_circled_solid : CupertinoIcons.circle,
                        size: 22,
                        color: isPrivate ? theme.colorScheme.primary : theme.colorScheme.onSurface.withAlpha(80),
                      ),
                      const SizedBox(width: 12),
                      Text(
                        '设为隐私歌单',
                        style: TextStyle(
                          fontSize: 14,
                          fontWeight: FontWeight.w600,
                          color: theme.colorScheme.onSurface,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ],
        ),
        confirmText: '创建',
        onConfirm: () async {
          final name = nameController.text.trim();
          if (name.isEmpty) {
            CustomToast.warning(context, '请输入歌单名称');
            return;
          }

          Navigator.pop(context);

          if (context.mounted) {
            final userProvider = context.read<UserProvider>();
            final success = await userProvider.createPlaylist(
              name,
              isPrivate: isPrivateNotifier.value,
            );

            if (context.mounted) {
              if (success) {
                CustomToast.success(context, '创建成功');
              } else {
                CustomToast.error(context, '创建失败，请重试');
              }
            }
          }
        },
        onCancel: () => Navigator.pop(context),
      ),
    );
  }

  Widget _buildNavItem(BuildContext context, int index, IconData icon, String label) {
    final isSelected = selectedPlaylistId == null && selectedIndex == index;
    final theme = Theme.of(context);
    final accentColor = theme.colorScheme.primary;

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 2),
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        child: _NavItemWithHover(
          isSelected: isSelected,
          accentColor: accentColor,
          onTap: () {
            if (!isSelected) {
              onDestinationSelected(index);
            }
          },
          child: Row(
            children: [
              Icon(icon, color: isSelected ? accentColor : theme.colorScheme.onSurfaceVariant, size: 20),
              const SizedBox(width: 14),
              Text(label, style: TextStyle(color: isSelected ? accentColor : theme.colorScheme.onSurface, fontWeight: isSelected ? FontWeight.w800 : FontWeight.w700, fontSize: 14, letterSpacing: -0.2)),
            ],
          ),
        ),
      ),
    );
  }
}

class _NavItemWithHover extends StatefulWidget {
  final bool isSelected;
  final Color accentColor;
  final VoidCallback onTap;
  final Widget child;

  const _NavItemWithHover({
    required this.isSelected,
    required this.accentColor,
    required this.onTap,
    required this.child,
  });

  @override
  State<_NavItemWithHover> createState() => _NavItemWithHoverState();
}

class _NavItemWithHoverState extends State<_NavItemWithHover> {
  bool _isHovered = false;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return MouseRegion(
      onEnter: (_) => setState(() => _isHovered = true),
      onExit: (_) => setState(() => _isHovered = false),
      child: InkWell(
        onTap: widget.onTap,
        borderRadius: BorderRadius.circular(14),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 200),
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          decoration: BoxDecoration(
            color: widget.isSelected
                ? widget.accentColor.withAlpha(35)
                : _isHovered
                    ? theme.colorScheme.onSurface.withAlpha(8)
                    : Colors.transparent,
            borderRadius: BorderRadius.circular(14),
          ),
          child: widget.child,
        ),
      ),
    );
  }
}

class _TopItemWithHover extends StatefulWidget {
  final bool isSelected;
  final Color accentColor;
  final VoidCallback onTap;
  final Widget child;

  const _TopItemWithHover({
    required this.isSelected,
    required this.accentColor,
    required this.onTap,
    required this.child,
  });

  @override
  State<_TopItemWithHover> createState() => _TopItemWithHoverState();
}

class _TopItemWithHoverState extends State<_TopItemWithHover> {
  bool _isHovered = false;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return MouseRegion(
      onEnter: (_) => setState(() => _isHovered = true),
      onExit: (_) => setState(() => _isHovered = false),
      child: InkWell(
        onTap: widget.onTap,
        borderRadius: BorderRadius.circular(14),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 200),
          padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
          decoration: BoxDecoration(
            color: widget.isSelected
                ? widget.accentColor.withAlpha(30)
                : _isHovered
                    ? theme.colorScheme.onSurface.withAlpha(8)
                    : Colors.transparent,
            borderRadius: BorderRadius.circular(14),
          ),
          child: widget.child,
        ),
      ),
    );
  }
}

class _PlaylistItemWithHover extends StatefulWidget {
  final bool isSelected;
  final Color accentColor;
  final bool canDelete;
  final VoidCallback onTap;
  final VoidCallback? onDelete;
  final Widget child;

  const _PlaylistItemWithHover({
    required this.isSelected,
    required this.accentColor,
    required this.canDelete,
    required this.onTap,
    this.onDelete,
    required this.child,
  });

  @override
  State<_PlaylistItemWithHover> createState() => _PlaylistItemWithHoverState();
}

class _PlaylistItemWithHoverState extends State<_PlaylistItemWithHover> {
  bool _isHovered = false;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return MouseRegion(
      onEnter: (_) => setState(() => _isHovered = true),
      onExit: (_) => setState(() => _isHovered = false),
      child: InkWell(
        onTap: widget.onTap,
        borderRadius: BorderRadius.circular(12),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 200),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: BoxDecoration(
            color: widget.isSelected
                ? widget.accentColor.withAlpha(30)
                : _isHovered
                    ? theme.colorScheme.onSurface.withAlpha(8)
                    : Colors.transparent,
            borderRadius: BorderRadius.circular(12),
          ),
          child: Row(
            children: [
              Expanded(child: widget.child),
              if (widget.canDelete && widget.onDelete != null)
                AnimatedOpacity(
                  duration: const Duration(milliseconds: 150),
                  opacity: _isHovered ? 1.0 : 0.0,
                  child: AnimatedContainer(
                    duration: const Duration(milliseconds: 150),
                    width: _isHovered ? 24 : 0,
                    child: _isHovered
                        ? MouseRegion(
                            cursor: SystemMouseCursors.click,
                            child: InkWell(
                              onTap: widget.onDelete,
                              borderRadius: BorderRadius.circular(6),
                              child: Container(
                                padding: const EdgeInsets.all(4),
                                child: Icon(
                                  CupertinoIcons.xmark,
                                  size: 14,
                                  color: theme.colorScheme.error,
                                ),
                              ),
                            ),
                          )
                        : const SizedBox.shrink(),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
