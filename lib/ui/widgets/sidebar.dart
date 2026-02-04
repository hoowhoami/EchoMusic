import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import '../../providers/user_provider.dart';
import '../screens/login_screen.dart';
import '../screens/playlist_detail_view.dart';
import '../../models/playlist.dart';
import 'package:cached_network_image/cached_network_image.dart';
import 'dart:io';

import 'package:bitsdojo_window/bitsdojo_window.dart';

class Sidebar extends StatelessWidget {
  final int selectedIndex;
  final ValueChanged<int> onDestinationSelected;

  const Sidebar({
    super.key,
    required this.selectedIndex,
    required this.onDestinationSelected,
  });

  @override
  Widget build(BuildContext context) {
    final userProvider = context.watch<UserProvider>();
    final user = userProvider.user;
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final accentColor = Theme.of(context).primaryColor;

    return Column(
      children: [
        // Window Control & Drag Area
        SizedBox(
          height: 48,
          child: MoveWindow(),
        ),
        
        // User Branding / Profile
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 8),
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
            borderRadius: BorderRadius.circular(12),
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(12),
                gradient: LinearGradient(
                  colors: isDark 
                    ? [Colors.white.withAlpha(15), Colors.white.withAlpha(5)]
                    : [Colors.black.withAlpha(10), Colors.black.withAlpha(5)],
                ),
              ),
              child: Row(
                children: [
                  Container(
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      border: Border.all(color: accentColor.withAlpha(100), width: 1.5),
                    ),
                    child: CircleAvatar(
                      radius: 16,
                      backgroundColor: Colors.transparent,
                      backgroundImage: user?.pic != null 
                        ? CachedNetworkImageProvider(user!.pic!)
                        : null,
                      child: user?.pic == null 
                        ? Icon(CupertinoIcons.person_alt_circle_fill, color: isDark ? Colors.white60 : Colors.black45, size: 20)
                        : null,
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
                            color: isDark ? Colors.white : Colors.black,
                            fontWeight: FontWeight.w700,
                            fontSize: 13,
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        Text(
                          userProvider.isAuthenticated ? '账号中心' : '登录发现更多',
                          style: TextStyle(
                            color: isDark ? Colors.white54 : Colors.black45,
                            fontSize: 10,
                            fontWeight: FontWeight.w500,
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
        
        Expanded(
          child: SingleChildScrollView(
            padding: const EdgeInsets.only(bottom: 20),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _buildGroupTitle(context, '发现'),
                _buildNavItem(context, 0, CupertinoIcons.rocket_fill, '为您推荐'),
                _buildNavItem(context, 1, CupertinoIcons.compass_fill, '发现音乐'),
                _buildNavItem(context, 2, CupertinoIcons.search, '快速搜索'),
                
                const SizedBox(height: 24),
                _buildGroupTitle(context, '库'),
                _buildNavItem(context, 3, CupertinoIcons.time_solid, '播放历史'),
                _buildNavItem(context, 4, CupertinoIcons.cloud_upload_fill, '我的云盘'),
                
                const SizedBox(height: 24),
                _buildPlaylistSection(context, userProvider, isDark),
                
                const SizedBox(height: 24),
                _buildNavItem(context, 5, CupertinoIcons.slider_horizontal_3, '应用设置'),
              ],
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildGroupTitle(BuildContext context, String title) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return Padding(
      padding: const EdgeInsets.only(left: 24, right: 16, top: 8, bottom: 8),
      child: Text(
        title,
        style: TextStyle(
          color: isDark ? Colors.white24 : Colors.black26,
          fontSize: 11,
          fontWeight: FontWeight.w800,
          letterSpacing: 1.2,
        ),
      ),
    );
  }

  Widget _buildPlaylistSection(BuildContext context, UserProvider userProvider, bool isDark) {
    final createdPlaylists = userProvider.userPlaylists.where((p) => p['list_create_userid'] == userProvider.user?.userid).toList();
    final likedPlaylists = userProvider.userPlaylists.where((p) => p['list_create_userid'] != userProvider.user?.userid).toList();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _buildGroupTitle(context, '我的歌单'),
        
        if (userProvider.isAuthenticated) ...[
          for (var p in createdPlaylists)
            _buildPlaylistItem(context, p, CupertinoIcons.music_note_2, isDark),

          for (var p in likedPlaylists)
            _buildPlaylistItem(context, p, CupertinoIcons.heart_circle_fill, isDark, imageUrl: p['pic']),
        ] else
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 8),
            child: Text(
              '登录同步歌单',
              style: TextStyle(color: isDark ? Colors.white12 : Colors.black12, fontSize: 12),
            ),
          ),
      ],
    );
  }

  Widget _buildPlaylistItem(BuildContext context, Map<String, dynamic> playlistData, IconData icon, bool isDark, {String? imageUrl}) {
    final playlist = Playlist.fromJson(playlistData);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 1),
      child: InkWell(
        onTap: () {
          Navigator.push(
            context,
            CupertinoPageRoute(builder: (_) => PlaylistDetailView(playlist: playlist)),
          );
        },
        borderRadius: BorderRadius.circular(10),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          child: Row(
            children: [
              if (imageUrl != null)
                ClipRRect(
                  borderRadius: BorderRadius.circular(6),
                  child: CachedNetworkImage(
                    imageUrl: imageUrl.replaceAll('{size}', '40'),
                    width: 22,
                    height: 22,
                    fit: BoxFit.cover,
                    errorWidget: (_, __, ___) => Icon(icon, color: isDark ? Colors.white54 : Colors.black54, size: 16),
                  ),
                )
              else
                Icon(icon, color: isDark ? Colors.white54 : Colors.black54, size: 16),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  playlist.name,
                  style: TextStyle(
                    color: isDark ? Colors.white.withAlpha(180) : Colors.black.withAlpha(180), 
                    fontSize: 13,
                    fontWeight: FontWeight.w500,
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
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final accentColor = Theme.of(context).primaryColor;

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 2),
      child: InkWell(
        onTap: () => onDestinationSelected(index),
        borderRadius: BorderRadius.circular(10),
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 200),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          decoration: BoxDecoration(
            color: isSelected 
              ? accentColor.withAlpha(isDark ? 40 : 20)
              : Colors.transparent,
            borderRadius: BorderRadius.circular(10),
            border: isSelected 
              ? Border.all(color: accentColor.withAlpha(60), width: 1)
              : Border.all(color: Colors.transparent, width: 1),
          ),
          child: Row(
            children: [
              Icon(
                icon,
                color: isSelected ? accentColor : (isDark ? Colors.white38 : Colors.black38),
                size: 18,
              ),
              const SizedBox(width: 12),
              Text(
                label,
                style: TextStyle(
                  color: isSelected 
                    ? (isDark ? Colors.white : accentColor) 
                    : (isDark ? Colors.white.withAlpha(150) : Colors.black.withAlpha(150)),
                  fontWeight: isSelected ? FontWeight.w700 : FontWeight.w500,
                  fontSize: 13,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}


