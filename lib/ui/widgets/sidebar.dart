import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import '../../providers/user_provider.dart';
import '../screens/login_screen.dart';
import '../screens/playlist_detail_view.dart';
import '../../models/playlist.dart';
import 'cover_image.dart';

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

    return SingleChildScrollView(
      physics: const BouncingScrollPhysics(),
      padding: const EdgeInsets.only(bottom: 24),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const SizedBox(height: 12),

          // User Branding / Profile
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12),
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
              borderRadius: BorderRadius.circular(16),
              child: Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(16),
                  color: theme.colorScheme.onSurface.withAlpha(10),
                  border: Border.all(
                    color: theme.colorScheme.outlineVariant,
                    width: 1,
                  ),
                ),
                child: Row(
                  children: [
                    Container(
                      width: 40,
                      height: 40,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        boxShadow: [
                          BoxShadow(
                            color: accentColor.withAlpha(40),
                            blurRadius: 10,
                          ),
                        ],
                      ),
                      child: ClipOval(
                        child: user?.pic != null
                          ? CoverImage(
                              url: user!.pic!,
                              width: 40,
                              height: 40,
                              borderRadius: 0,
                              showShadow: false,
                              size: 100,
                            )
                          : Container(
                              color: accentColor.withAlpha(20),
                              child: Icon(CupertinoIcons.person_fill, color: accentColor, size: 20),
                            ),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            user?.nickname ?? '未登录',
                            style: TextStyle(
                              color: theme.colorScheme.onSurface,
                              fontWeight: FontWeight.w800,
                              fontSize: 14,
                              letterSpacing: -0.2,
                            ),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                          const SizedBox(height: 2),
                          Text(
                            userProvider.isAuthenticated ? '账号中心' : '登录发现更多',
                            style: TextStyle(
                              color: theme.colorScheme.onSurfaceVariant,
                              fontSize: 11,
                              fontWeight: FontWeight.w700,
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

          const SizedBox(height: 12),

          _buildGroupTitle(context, '发现'),
          _buildNavItem(context, 0, CupertinoIcons.rocket_fill, '为您推荐'),
          _buildNavItem(context, 1, CupertinoIcons.compass_fill, '发现音乐'),
          _buildNavItem(context, 2, CupertinoIcons.search, '快速搜索'),

          const SizedBox(height: 32),
          _buildGroupTitle(context, '库'),
          _buildNavItem(context, 3, CupertinoIcons.time_solid, '播放历史'),
          _buildNavItem(context, 4, CupertinoIcons.cloud_upload_fill, '我的云盘'),

          const SizedBox(height: 32),
          _buildPlaylistSection(context, userProvider),

          const SizedBox(height: 32),
          _buildNavItem(context, 5, CupertinoIcons.slider_horizontal_3, '应用设置'),
        ],
      ),
    );
  }

  Widget _buildGroupTitle(BuildContext context, String title) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(left: 28, right: 16, top: 8, bottom: 8),
      child: Text(
        title.toUpperCase(),
        style: TextStyle(
          color: theme.colorScheme.onSurface.withAlpha(160),
          fontSize: 11,
          fontWeight: FontWeight.w900,
          letterSpacing: 1.5,
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
              '登录同步歌单',
              style: TextStyle(
                color: theme.colorScheme.onSurface.withAlpha(120), 
                fontSize: 12,
                fontWeight: FontWeight.w600,
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
                width: 24,
                height: 24,
                borderRadius: 6,
                showShadow: false,
                size: 100,
                errorWidget: Icon(icon, color: theme.colorScheme.onSurfaceVariant, size: 14),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Text(
                  playlist.name,
                  style: TextStyle(
                    color: theme.colorScheme.onSurface, 
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
    );
  }

  Widget _buildNavItem(BuildContext context, int index, IconData icon, String label) {
    final isSelected = selectedIndex == index;
    final theme = Theme.of(context);
    final accentColor = theme.colorScheme.primary;

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 2),
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
    );
  }
}


