import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';

import 'app_menu.dart';

Future<Map<String, dynamic>?> showPlaylistPickerDialog(
  BuildContext context, {
  required List<Map<String, dynamic>> playlists,
  String title = '添加到歌单',
  bool useRootNavigator = true,
}) {
  return showGeneralDialog<Map<String, dynamic>>(
    context: context,
    useRootNavigator: useRootNavigator,
    barrierDismissible: true,
    barrierLabel: title,
    barrierColor: Colors.black.withAlpha(40),
    transitionDuration: const Duration(milliseconds: 220),
    pageBuilder: (dialogContext, _, _) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 440, maxHeight: 560),
            child: Material(
              color: Colors.transparent,
              child: AppMenuPanel(
                padding: const EdgeInsets.fromLTRB(10, 10, 10, 8),
                borderRadius: const BorderRadius.all(Radius.circular(24)),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Padding(
                      padding: const EdgeInsets.fromLTRB(8, 4, 8, 6),
                      child: Row(
                        children: [
                          Container(
                            width: 34,
                            height: 34,
                            decoration: BoxDecoration(
                              color: Theme.of(dialogContext)
                                  .colorScheme
                                  .primary
                                  .withAlpha(18),
                              borderRadius: BorderRadius.circular(12),
                            ),
                            child: Icon(
                              CupertinoIcons.music_note_list,
                              size: 17,
                              color: Theme.of(dialogContext).colorScheme.primary,
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Text(
                              title,
                              style: TextStyle(
                                fontSize: 16,
                                fontWeight: FontWeight.w900,
                                color:
                                    Theme.of(dialogContext).colorScheme.onSurface,
                              ),
                            ),
                          ),
                          IconButton(
                            tooltip: '关闭',
                            onPressed: () => Navigator.of(dialogContext).pop(),
                            icon: const Icon(CupertinoIcons.xmark, size: 17),
                            visualDensity: const VisualDensity(
                              horizontal: -2,
                              vertical: -2,
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 4),
                    Flexible(
                      child: playlists.isEmpty
                          ? Center(
                              child: Padding(
                                padding: const EdgeInsets.symmetric(vertical: 28),
                                child: Text(
                                  '暂无可用歌单',
                                  style: TextStyle(
                                    fontSize: 13,
                                    fontWeight: FontWeight.w600,
                                    color: Theme.of(dialogContext)
                                        .colorScheme
                                        .onSurfaceVariant,
                                  ),
                                ),
                              ),
                            )
                          : ListView.separated(
                              shrinkWrap: true,
                              itemCount: playlists.length,
                              separatorBuilder: (_, _) => const SizedBox(height: 4),
                              itemBuilder: (context, index) {
                                final playlist = playlists[index];
                                return AppMenuItemButton(
                                  leading: Container(
                                    width: 38,
                                    height: 38,
                                    decoration: BoxDecoration(
                                      color: Theme.of(context)
                                          .colorScheme
                                          .primary
                                          .withAlpha(16),
                                      borderRadius: BorderRadius.circular(12),
                                    ),
                                    child: Icon(
                                      CupertinoIcons.music_note_list,
                                      size: 18,
                                      color:
                                          Theme.of(context).colorScheme.primary,
                                    ),
                                  ),
                                  title: Text(
                                    _playlistName(playlist),
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: TextStyle(
                                      fontSize: 14,
                                      fontWeight: FontWeight.w700,
                                      color:
                                          Theme.of(context).colorScheme.onSurface,
                                    ),
                                  ),
                                  subtitle: Text(
                                    '${_playlistCount(playlist)} 首歌曲',
                                    style: TextStyle(
                                      fontSize: 11,
                                      fontWeight: FontWeight.w600,
                                      color: Theme.of(context)
                                          .colorScheme
                                          .onSurfaceVariant,
                                    ),
                                  ),
                                  trailing: Icon(
                                    CupertinoIcons.chevron_right,
                                    size: 13,
                                    color: Theme.of(context)
                                        .colorScheme
                                        .onSurfaceVariant,
                                  ),
                                  onPressed: () => Navigator.of(dialogContext).pop(
                                    playlist,
                                  ),
                                );
                              },
                            ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      );
    },
    transitionBuilder: (context, animation, _, child) {
      final curved = CurvedAnimation(parent: animation, curve: Curves.easeOutCubic);
      return FadeTransition(
        opacity: curved,
        child: SlideTransition(
          position: Tween<Offset>(
            begin: const Offset(0, 0.02),
            end: Offset.zero,
          ).animate(curved),
          child: child,
        ),
      );
    },
  );
}

String _playlistName(Map<String, dynamic> playlist) {
  return (playlist['specialname'] ?? playlist['name'] ?? '未命名歌单').toString();
}

int _playlistCount(Map<String, dynamic> playlist) {
  return (playlist['count'] ?? playlist['song_count'] ?? 0) as int;
}