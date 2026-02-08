import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import 'package:echomusic/providers/user_provider.dart';
import '../screens/login_screen.dart';
import '../../models/playlist.dart';
import 'cover_image.dart';

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
    final userProvider = context.watch<UserProvider>();
    final user = userProvider.user;
    final accentColor = theme.colorScheme.primary;

    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 20, 16, 12),
          child: Container(
            padding: const EdgeInsets.all(4),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(20),
              color: theme.colorScheme.onSurface.withAlpha(10),
              border: Border.all(color: theme.colorScheme.outlineVariant.withAlpha(80), width: 1),
            ),
            child: Row(
              children: [
                Expanded(child: _buildTopProfileItem(context, userProvider, user, theme, accentColor)),
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
                _buildPlaylistSection(context, userProvider),
              ],
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildTopProfileItem(BuildContext context, UserProvider userProvider, dynamic user, ThemeData theme, Color accentColor) {
    final isSelected = selectedPlaylistId == null && selectedIndex == 6;
    return InkWell(
      onTap: () {
        if (!userProvider.isAuthenticated) {
          Navigator.push(context, CupertinoPageRoute(builder: (_) => const LoginScreen()));
        } else {
          onDestinationSelected(6);
        }
      },
      borderRadius: BorderRadius.circular(14),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
        decoration: BoxDecoration(color: isSelected ? accentColor.withAlpha(30) : Colors.transparent, borderRadius: BorderRadius.circular(14)),
        child: Row(
          children: [
            ClipOval(child: user?.pic != null ? CoverImage(url: user!.pic!, width: 34, height: 34, borderRadius: 0, showShadow: false, size: 100) : Container(width: 34, height: 34, color: accentColor.withAlpha(20), child: Icon(CupertinoIcons.person_fill, color: accentColor, size: 18))),
            const SizedBox(width: 12),
            Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [Text(user?.nickname ?? '未登录', style: TextStyle(color: isSelected ? accentColor : theme.colorScheme.onSurface, fontWeight: FontWeight.w900, fontSize: 13, letterSpacing: -0.4), maxLines: 1, overflow: TextOverflow.ellipsis), Text(userProvider.isAuthenticated ? 'Lv.${user?.extendsInfo?['detail']?['p_grade'] ?? 0}' : '点击登录账号', style: TextStyle(color: isSelected ? accentColor.withAlpha(180) : theme.colorScheme.onSurfaceVariant, fontSize: 9, fontWeight: FontWeight.w800, letterSpacing: 0.2))])),
          ],
        ),
      ),
    );
  }

  Widget _buildSettingsIconButton(BuildContext context, int index, ValueChanged<int> onTap, ThemeData theme, Color accentColor) {
    final isSelected = selectedPlaylistId == null && selectedIndex == index;
    return InkWell(
      onTap: () => onTap(index),
      borderRadius: BorderRadius.circular(14),
      child: Container(padding: const EdgeInsets.all(10), decoration: BoxDecoration(color: isSelected ? accentColor.withAlpha(30) : Colors.transparent, borderRadius: BorderRadius.circular(14)), child: Icon(CupertinoIcons.settings_solid, color: isSelected ? accentColor : theme.colorScheme.onSurfaceVariant, size: 20)),
    );
  }

  Widget _buildGroupTitle(BuildContext context, String title) {
    final theme = Theme.of(context);
    return Padding(padding: const EdgeInsets.only(left: 28, right: 16, top: 8, bottom: 10), child: Text(title, style: TextStyle(color: theme.colorScheme.onSurface.withAlpha(120), fontSize: 11, fontWeight: FontWeight.w900, letterSpacing: 1.2)));
  }

  Widget _buildPlaylistSection(BuildContext context, UserProvider userProvider) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _buildGroupTitle(context, '我的歌单'),
        if (userProvider.isAuthenticated) ...[
          for (var p in userProvider.createdPlaylists) _buildPlaylistItem(context, p, CupertinoIcons.music_note_2),
          for (var p in userProvider.favoritedPlaylists) _buildPlaylistItem(context, p, CupertinoIcons.heart_circle_fill, imageUrl: p['pic']),
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

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 1),
      child: InkWell(
        onTap: () => onPushPlaylist?.call(playlist),
        borderRadius: BorderRadius.circular(12),
        child: AnimatedContainer(duration: const Duration(milliseconds: 200), padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8), decoration: BoxDecoration(color: isSelected ? accentColor.withAlpha(30) : Colors.transparent, borderRadius: BorderRadius.circular(12)), child: Row(children: [CoverImage(url: imageUrl, width: 26, height: 26, borderRadius: 6, showShadow: false, size: 100, errorWidget: Container(decoration: BoxDecoration(color: theme.colorScheme.onSurface.withAlpha(10), borderRadius: BorderRadius.circular(6)), child: Icon(icon, color: isSelected ? accentColor : theme.colorScheme.onSurfaceVariant, size: 14))), const SizedBox(width: 14), Expanded(child: Text(playlist.name, style: TextStyle(color: isSelected ? accentColor : theme.colorScheme.onSurface.withAlpha(220), fontSize: 13, fontWeight: isSelected ? FontWeight.w800 : FontWeight.w700, letterSpacing: -0.2), maxLines: 1, overflow: TextOverflow.ellipsis))])),
      ),
    );
  }

  Widget _buildNavItem(BuildContext context, int index, IconData icon, String label) {
    final isSelected = selectedPlaylistId == null && selectedIndex == index;
    final theme = Theme.of(context);
    final accentColor = theme.colorScheme.primary;

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 2),
      child: InkWell(
        onTap: () => onDestinationSelected(index),
        borderRadius: BorderRadius.circular(14),
        child: AnimatedContainer(duration: const Duration(milliseconds: 200), padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12), decoration: BoxDecoration(color: isSelected ? accentColor.withAlpha(35) : Colors.transparent, borderRadius: BorderRadius.circular(14)), child: Row(children: [Icon(icon, color: isSelected ? accentColor : theme.colorScheme.onSurfaceVariant, size: 20), const SizedBox(width: 14), Text(label, style: TextStyle(color: isSelected ? accentColor : theme.colorScheme.onSurface, fontWeight: isSelected ? FontWeight.w800 : FontWeight.w700, fontSize: 14, letterSpacing: -0.2))])),
      ),
    );
  }
}
