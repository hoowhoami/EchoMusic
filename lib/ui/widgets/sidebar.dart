import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import '../../providers/user_provider.dart';
import '../screens/login_screen.dart';
import '../screens/playlist_detail_view.dart';
import '../../models/playlist.dart';
import 'cover_image.dart';
import '../widgets/custom_dialog.dart';

class Sidebar extends StatelessWidget {
  final int selectedIndex;
  final ValueChanged<int> onDestinationSelected;
  final void Function(Widget)? onPushRoute;

  const Sidebar({
    super.key,
    required this.selectedIndex,
    required this.onDestinationSelected,
    this.onPushRoute,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final userProvider = context.watch<UserProvider>();
    final user = userProvider.user;
    final accentColor = theme.colorScheme.primary;

    return Column(
      children: [
        // Top Profile Section
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 20, 20, 16),
          child: MouseRegion(
            cursor: SystemMouseCursors.click,
            child: InkWell(
              onTap: () {
                if (!userProvider.isAuthenticated) {
                  Navigator.of(context).push(
                    CupertinoPageRoute(builder: (_) => const LoginScreen()),
                  );
                } else {
                  onDestinationSelected(6);
                }
              },
              borderRadius: BorderRadius.circular(20),
              child: Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(20),
                  color: theme.colorScheme.onSurface.withAlpha(10),
                  border: Border.all(
                    color: theme.colorScheme.outlineVariant.withAlpha(80),
                    width: 1,
                  ),
                ),
                child: Row(
                  children: [
                    Container(
                      width: 42,
                      height: 42,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        boxShadow: [
                          BoxShadow(
                            color: accentColor.withAlpha(30),
                            blurRadius: 12,
                            offset: const Offset(0, 4),
                          ),
                        ],
                      ),
                      child: ClipOval(
                        child: user?.pic != null
                          ? CoverImage(
                              url: user!.pic!,
                              width: 42,
                              height: 42,
                              borderRadius: 0,
                              showShadow: false,
                              size: 100,
                            )
                          : Container(
                              color: accentColor.withAlpha(20),
                              child: Icon(CupertinoIcons.person_fill, color: accentColor, size: 22),
                            ),
                      ),
                    ),
                    const SizedBox(width: 14),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            user?.nickname ?? '未登录',
                            style: TextStyle(
                              color: theme.colorScheme.onSurface,
                              fontWeight: FontWeight.w900,
                              fontSize: 14,
                              letterSpacing: -0.4,
                            ),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                          const SizedBox(height: 3),
                          Text(
                            userProvider.isAuthenticated ? '个人中心' : '点击登录账号',
                            style: TextStyle(
                              color: theme.colorScheme.onSurfaceVariant,
                              fontSize: 10,
                              fontWeight: FontWeight.w800,
                              letterSpacing: 0.2,
                            ),
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

        // Scrollable Navigation Section
        Expanded(
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

                const SizedBox(height: 28),
                _buildGroupTitle(context, '我的库'),
                _buildNavItem(context, 3, CupertinoIcons.clock_fill, '播放历史'),
                _buildNavItem(context, 4, CupertinoIcons.cloud_fill, '我的云盘'),

                const SizedBox(height: 28),
                _buildPlaylistSection(context, userProvider),
              ],
            ),
          ),
        ),

        // Bottom Static Action Section
        Padding(
          padding: const EdgeInsets.all(16),
          child: Container(
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(
              color: theme.colorScheme.onSurface.withAlpha(8),
              borderRadius: BorderRadius.circular(20),
            ),
            child: Column(
              children: [
                _buildStaticActionItem(
                  context,
                  index: 5,
                  icon: CupertinoIcons.settings_solid,
                  label: '应用设置',
                  onTap: () => onDestinationSelected(5),
                ),
                if (userProvider.isAuthenticated) ...[
                  const SizedBox(height: 4),
                  _buildStaticActionItem(
                    context,
                    icon: CupertinoIcons.power,
                    label: '退出登录',
                    color: theme.colorScheme.error,
                    onTap: () => _showLogoutDialog(context, userProvider),
                  ),
                ],
              ],
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildStaticActionItem(BuildContext context, {int? index, required IconData icon, required String label, required VoidCallback onTap, Color? color}) {
    final isSelected = index != null && selectedIndex == index;
    final theme = Theme.of(context);
    final accentColor = theme.colorScheme.primary;

    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(12),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
          decoration: BoxDecoration(
            color: isSelected ? accentColor.withAlpha(30) : Colors.transparent,
            borderRadius: BorderRadius.circular(12),
          ),
          child: Row(
            children: [
              Icon(
                icon,
                color: isSelected ? accentColor : (color ?? theme.colorScheme.onSurfaceVariant),
                size: 18,
              ),
              const SizedBox(width: 12),
              Text(
                label,
                style: TextStyle(
                  color: isSelected ? accentColor : (color ?? theme.colorScheme.onSurface),
                  fontWeight: isSelected ? FontWeight.w800 : FontWeight.w700,
                  fontSize: 13,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildGroupTitle(BuildContext context, String title) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(left: 28, right: 16, top: 8, bottom: 10),
      child: Text(
        title,
        style: TextStyle(
          color: theme.colorScheme.onSurface.withAlpha(120),
          fontSize: 11,
          fontWeight: FontWeight.w900,
          letterSpacing: 1.2,
        ),
      ),
    );
  }

  Widget _buildPlaylistSection(BuildContext context, UserProvider userProvider) {
    final theme = Theme.of(context);
    final createdPlaylists = userProvider.userPlaylists.where((p) => p['list_create_userid'] == userProvider.user?.userid).toList();
    final likedPlaylists = userProvider.userPlaylists.where((p) => p['list_create_userid'] != userProvider.user?.userid).toList();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _buildGroupTitle(context, '我的歌单'),
        
        if (userProvider.isAuthenticated) ...[
          for (var p in createdPlaylists)
            _buildPlaylistItem(context, p, CupertinoIcons.music_note_2),

          for (var p in likedPlaylists)
            _buildPlaylistItem(context, p, CupertinoIcons.heart_circle_fill, imageUrl: p['pic']),
        ] else
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 8),
            child: Text(
              '登录同步云端歌单',
              style: TextStyle(
                color: theme.colorScheme.onSurface.withAlpha(80), 
                fontSize: 12,
                fontWeight: FontWeight.w600,
                fontStyle: FontStyle.italic,
              ),
            ),
          ),
      ],
    );
  }

  Widget _buildPlaylistItem(BuildContext context, Map<String, dynamic> playlistData, IconData icon, {String? imageUrl}) {
    final playlist = Playlist.fromJson(playlistData);
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 1),
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        child: InkWell(
          onTap: () {
            if (onPushRoute != null) {
              onPushRoute!(PlaylistDetailView(playlist: playlist));
            } else {
              Navigator.push(
                context,
                CupertinoPageRoute(builder: (_) => PlaylistDetailView(playlist: playlist)),
              );
            }
          },
          borderRadius: BorderRadius.circular(12),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
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
                    child: Icon(icon, color: theme.colorScheme.onSurfaceVariant, size: 14),
                  ),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Text(
                    playlist.name,
                    style: TextStyle(
                      color: theme.colorScheme.onSurface.withAlpha(220), 
                      fontSize: 13,
                      fontWeight: FontWeight.w700,
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
      ),
    );
  }

  Widget _buildNavItem(BuildContext context, int index, IconData icon, String label) {
    final isSelected = selectedIndex == index;
    final theme = Theme.of(context);
    final accentColor = theme.colorScheme.primary;

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 2),
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        child: InkWell(
          onTap: () => onDestinationSelected(index),
          borderRadius: BorderRadius.circular(14),
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 200),
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            decoration: BoxDecoration(
              color: isSelected 
                ? accentColor.withAlpha(35)
                : Colors.transparent,
              borderRadius: BorderRadius.circular(14),
            ),
            child: Row(
              children: [
                Icon(
                  icon,
                  color: isSelected ? accentColor : theme.colorScheme.onSurfaceVariant,
                  size: 20,
                ),
                const SizedBox(width: 14),
                Text(
                  label,
                  style: TextStyle(
                    color: isSelected 
                      ? accentColor 
                      : theme.colorScheme.onSurface,
                    fontWeight: isSelected ? FontWeight.w800 : FontWeight.w700,
                    fontSize: 14,
                    letterSpacing: -0.2,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  void _showLogoutDialog(BuildContext context, UserProvider userProvider) {
    CustomDialog.show(
      context,
      title: '确认退出登录',
      content: '退出登录将清空您的用户信息，但会保留设备关联信息。',
      confirmText: '退出登录',
      isDestructive: true,
    ).then((confirmed) {
      if (confirmed == true) {
        userProvider.logout();
      }
    });
  }
}