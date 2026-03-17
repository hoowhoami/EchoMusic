import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../models/song.dart';
import '../../providers/audio_provider.dart';
import '../../providers/user_provider.dart';
import 'cover_image.dart';
import 'custom_dialog.dart';
import 'custom_toast.dart';
import 'playlist_picker_dialog.dart';
import 'song_table_layout.dart';
import 'package:echomusic/theme/app_theme.dart';

Future<void> showSongBatchSelectionDialog(
  BuildContext context, {
  required List<Song> songs,
  dynamic sourceId,
}) {
  return showGeneralDialog<void>(
    context: context,
    useRootNavigator: false,
    barrierLabel: '批量',
    barrierDismissible: true,
    barrierColor: Colors.black.withAlpha(90),
    pageBuilder: (_, _, _) =>
        _SongBatchSelectionDialog(songs: songs, sourceId: sourceId),
    transitionBuilder: (context, animation, _, child) {
      final curved = CurvedAnimation(
        parent: animation,
        curve: Curves.easeOutCubic,
      );
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

class SongBatchActionButton extends StatefulWidget {
  final List<Song> songs;
  final dynamic sourceId;
  final Future<List<Song>> Function()? onResolveSongs;
  final bool isLoadingHint;

  const SongBatchActionButton({
    super.key,
    required this.songs,
    this.sourceId,
    this.onResolveSongs,
    this.isLoadingHint = false,
  });

  @override
  State<SongBatchActionButton> createState() => _SongBatchActionButtonState();
}

class _SongBatchActionButtonState extends State<SongBatchActionButton> {
  bool _isPreparing = false;

  Future<void> _openBatchDialog() async {
    if (_isPreparing || widget.songs.isEmpty) return;
    setState(() => _isPreparing = true);
    try {
      final songs =
          await (widget.onResolveSongs?.call() ?? Future.value(widget.songs));
      if (!mounted || songs.isEmpty) return;
      await showSongBatchSelectionDialog(
        context,
        songs: songs,
        sourceId: widget.sourceId,
      );
    } catch (_) {
      if (mounted) CustomToast.error(context, '加载全部歌曲失败');
    } finally {
      if (mounted) setState(() => _isPreparing = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final isLoading = _isPreparing || widget.isLoadingHint;
    return FilledButton.icon(
      onPressed: widget.songs.isEmpty || _isPreparing ? null : _openBatchDialog,
      icon: isLoading
          ? const SizedBox(
              width: 14,
              height: 14,
              child: CupertinoActivityIndicator(radius: 7),
            )
          : const Icon(CupertinoIcons.checkmark_rectangle, size: 16),
      label: const Text('批量'),
      style: _buildDialogActionStyle(context),
    );
  }
}

class _SongBatchSelectionDialog extends StatefulWidget {
  final List<Song> songs;
  final dynamic sourceId;

  const _SongBatchSelectionDialog({required this.songs, this.sourceId});

  @override
  State<_SongBatchSelectionDialog> createState() =>
      _SongBatchSelectionDialogState();
}

class _SongBatchSelectionDialogState extends State<_SongBatchSelectionDialog> {
  final Set<String> _selectedKeys = <String>{};

  List<Song> get _selectedSongs => widget.songs
      .where((song) => _selectedKeys.contains(_songKey(song)))
      .toList();

  bool get _allSelected =>
      widget.songs.isNotEmpty && _selectedKeys.length == widget.songs.length;

  bool? get _selectAllValue =>
      _allSelected ? true : (_selectedKeys.isEmpty ? false : null);

  void _toggleSong(Song song) {
    final key = _songKey(song);
    setState(() {
      if (_selectedKeys.contains(key)) {
        _selectedKeys.remove(key);
      } else {
        _selectedKeys.add(key);
      }
    });
  }

  void _toggleSelectAll(bool? value) {
    setState(() {
      if (_allSelected || value == false) {
        _selectedKeys.clear();
      } else {
        _selectedKeys
          ..clear()
          ..addAll(widget.songs.map(_songKey));
      }
    });
  }

  Future<void> _playSelected() async {
    if (_selectedSongs.isEmpty) return;
    final hasPlayable = _selectedSongs.any((song) => song.isPlayable);
    if (!hasPlayable) {
      if (_selectedSongs.any((song) => song.isNoCopyright)) {
        CustomToast.error(context, '所选歌曲包含无版权内容');
      } else if (_selectedSongs.any((song) => song.isPayBlocked || song.isPaid)) {
        CustomToast.error(context, '所选歌曲包含需要购买的内容');
      } else {
        CustomToast.error(context, '所选歌曲暂无可用音源');
      }
      return;
    }
    await context.read<AudioProvider>().playSong(
      _selectedSongs.first,
      playlist: _selectedSongs,
    );
    if (mounted) Navigator.of(context).pop();
  }

  Future<void> _addToPlaylist() async {
    final userProvider = context.read<UserProvider>();
    if (!userProvider.isAuthenticated) {
      CustomToast.warning(context, '请先登录后再添加');
      return;
    }
    final playlist = await showPlaylistPickerDialog(
      context,
      playlists: userProvider.createdPlaylists,
      useRootNavigator: false,
    );
    if (playlist == null) return;
    final count = await userProvider.addSongsToPlaylist(
      playlist['listid'] ?? playlist['specialid'],
      _selectedSongs,
    );
    if (!mounted) return;
    if (count > 0) {
      CustomToast.success(context, '成功添加 $count 首歌曲到歌单');
      Navigator.of(context).pop();
    } else {
      CustomToast.error(context, '添加失败');
    }
  }

  Future<void> _deleteSelected() async {
    final userProvider = context.read<UserProvider>();
    final confirmed = await CustomDialog.show(
      context,
      title: '确认删除',
      content: '确定要从当前歌单删除已勾选的 ${_selectedSongs.length} 首歌曲吗？',
      confirmText: '删除',
      isDestructive: true,
    );
    if (confirmed != true) return;
    final count = await userProvider.removeSongsFromPlaylist(
      widget.sourceId,
      _selectedSongs,
    );
    if (!mounted) return;
    if (count > 0) {
      CustomToast.success(context, '已删除 $count 首歌曲');
      Navigator.of(context).pop();
    } else {
      CustomToast.error(context, '删除失败');
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final userProvider = context.watch<UserProvider>();
    final size = MediaQuery.sizeOf(context);
    final hasSelection = _selectedKeys.isNotEmpty;
    final canAdd = hasSelection && userProvider.isAuthenticated;
    final canDelete =
        hasSelection &&
        userProvider.isAuthenticated &&
        widget.sourceId != null &&
        userProvider.isCreatedPlaylist(widget.sourceId);
    final borderRadius = BorderRadius.circular(24);

    return Material(
      color: Colors.transparent,
      child: SafeArea(
        minimum: const EdgeInsets.all(24),
        child: Center(
          child: ConstrainedBox(
            constraints: BoxConstraints(
              maxWidth: 1040,
              maxHeight: size.height * 0.86,
            ),
            child: DecoratedBox(
              decoration: BoxDecoration(
                color: theme.colorScheme.surface,
                borderRadius: borderRadius,
                border: Border.all(
                  color: theme.colorScheme.outlineVariant.withAlpha(90),
                  width: 0.8,
                ),
                boxShadow: [
                  BoxShadow(
                    color: Colors.black.withAlpha(28),
                    blurRadius: 30,
                    offset: const Offset(0, 14),
                  ),
                ],
              ),
              child: ClipRRect(
                borderRadius: borderRadius,
                child: Material(
                  color: Colors.transparent,
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Padding(
                        padding: const EdgeInsets.fromLTRB(18, 12, 12, 12),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                Expanded(
                                  child: Wrap(
                                    spacing: 8,
                                    runSpacing: 8,
                                    children: [
                                      FilledButton.icon(
                                        onPressed: hasSelection
                                            ? _playSelected
                                            : null,
                                        icon: const Icon(
                                          CupertinoIcons.play_fill,
                                          size: 16,
                                        ),
                                        label: const Text('播放'),
                                        style: _buildDialogActionStyle(context),
                                      ),
                                      FilledButton.icon(
                                        onPressed: canAdd
                                            ? _addToPlaylist
                                            : null,
                                        icon: const Icon(
                                          CupertinoIcons.add,
                                          size: 16,
                                        ),
                                        label: const Text('添加到'),
                                        style: _buildDialogActionStyle(context),
                                      ),
                                      FilledButton.icon(
                                        onPressed: canDelete
                                            ? _deleteSelected
                                            : null,
                                        icon: const Icon(
                                          CupertinoIcons.delete,
                                          size: 16,
                                        ),
                                        label: const Text('删除'),
                                        style: _buildDialogActionStyle(context),
                                      ),
                                    ],
                                  ),
                                ),
                                IconButton(
                                  tooltip: '关闭',
                                  onPressed: () => Navigator.of(context).pop(),
                                  icon: const Icon(
                                    CupertinoIcons.xmark,
                                    size: 18,
                                  ),
                                  visualDensity: const VisualDensity(
                                    horizontal: -2,
                                    vertical: -2,
                                  ),
                                ),
                              ],
                            ),
                            const SizedBox(height: 10),
                            Padding(
                              padding: const EdgeInsets.only(left: 4),
                              child: Row(
                                children: [
                                  Checkbox(
                                    value: _selectAllValue,
                                    tristate: true,
                                    onChanged: widget.songs.isEmpty
                                        ? null
                                        : _toggleSelectAll,
                                    visualDensity: const VisualDensity(
                                      horizontal: -4,
                                      vertical: -4,
                                    ),
                                    materialTapTargetSize:
                                        MaterialTapTargetSize.shrinkWrap,
                                  ),
                                  const SizedBox(width: 6),
                                  const Text(
                                    '全选',
                                    style: TextStyle(
                                      fontSize: 12,
                                      fontWeight: AppTheme.fontWeightBold,
                                    ),
                                  ),
                                  const SizedBox(width: 12),
                                  Text(
                                    '已选 ${_selectedSongs.length} / ${widget.songs.length}',
                                    style: TextStyle(
                                      color: theme.colorScheme.onSurfaceVariant,
                                      fontWeight: AppTheme.fontWeightSemiBold,
                                      fontSize: 12,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ],
                        ),
                      ),
                      Divider(
                        height: 1,
                        color: theme.colorScheme.outlineVariant.withAlpha(120),
                      ),
                      Expanded(
                        child: ListView.separated(
                          padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
                          itemCount: widget.songs.length,
                          separatorBuilder: (_, _) => Divider(
                            height: 1,
                            color: theme.colorScheme.outlineVariant.withAlpha(
                              80,
                            ),
                          ),
                          itemBuilder: (context, index) {
                            final song = widget.songs[index];
                            return _BatchSongTile(
                              song: song,
                              selected: _selectedKeys.contains(_songKey(song)),
                              onTap: () => _toggleSong(song),
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
        ),
      ),
    );
  }
}

ButtonStyle _buildDialogActionStyle(BuildContext context) {
  final theme = Theme.of(context);
  return FilledButton.styleFrom(
    backgroundColor: theme.colorScheme.surfaceContainerHighest,
    foregroundColor: theme.colorScheme.onSurface,
    disabledBackgroundColor: theme.colorScheme.onSurface.withAlpha(20),
    disabledForegroundColor: theme.disabledColor,
    minimumSize: const Size(0, 36),
    fixedSize: const Size.fromHeight(36),
    padding: const EdgeInsets.symmetric(horizontal: 12),
    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
    textStyle: const TextStyle(fontSize: 12, fontWeight: AppTheme.fontWeightBold),
  );
}

class _BatchSongTile extends StatelessWidget {
  final Song song;
  final bool selected;
  final VoidCallback onTap;

  const _BatchSongTile({
    required this.song,
    required this.selected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isPlayable = song.isPlayable;
    final contentOpacity = isPlayable ? 1.0 : 0.45;
    final isNoCopyright = song.isNoCopyright;
    final isPayBlocked = song.isPayBlocked || song.isPaid;
    final unavailableTag = !isPlayable
        ? (isNoCopyright
            ? '版权'
            : isPayBlocked
                ? '付费'
                : '音源')
        : null;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(12),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 7),
        child: Row(
          children: [
            SizedBox(
              width: SongTableLayout.batchLeadingWidth,
              child: Row(
                children: [
                  Checkbox(
                    value: selected,
                    onChanged: (_) => onTap(),
                    visualDensity: const VisualDensity(
                      horizontal: -4,
                      vertical: -4,
                    ),
                    materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  ),
                  const SizedBox(width: 16),
                  Opacity(
                    opacity: contentOpacity,
                    child: CoverImage(
                      url: song.cover,
                      width: 38,
                      height: 38,
                      borderRadius: 8,
                      showShadow: false,
                      size: 160,
                    ),
                  ),
                  const SizedBox(width: 10),
                ],
              ),
            ),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: SongTableLayout.batchTitleMaxWidth,
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Flexible(
                          child: Text(
                            song.name,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontSize: 13,
                              fontWeight: AppTheme.fontWeightBold,
                              height: 1.1,
                              color: theme.colorScheme.onSurface.withAlpha(
                                isPlayable ? 255 : 140,
                              ),
                            ),
                          ),
                        ),
                        if (unavailableTag != null)
                          _buildTag(context, unavailableTag, theme),
                      ],
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    song.singerName,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 11,
                      height: 1.1,
                      color: theme.colorScheme.onSurfaceVariant.withAlpha(
                        isPlayable ? 255 : 140,
                      ),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(width: SongTableLayout.batchAlbumGap),
            SizedBox(
              width: SongTableLayout.batchAlbumWidth,
              child: Text(
                song.displayAlbumName,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 11,
                  color: theme.colorScheme.onSurfaceVariant.withAlpha(
                    isPlayable ? 255 : 140,
                  ),
                ),
              ),
            ),
            const SizedBox(width: SongTableLayout.batchDurationGap),
            SizedBox(
              width: SongTableLayout.batchDurationWidth,
              child: Align(
                alignment: Alignment.centerRight,
                child: Text(
                  _formatDuration(song.duration),
                  style: TextStyle(
                    fontSize: 11,
                    fontFamily: 'monospace',
                    color: theme.colorScheme.onSurfaceVariant.withAlpha(
                      isPlayable ? 255 : 140,
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

Widget _buildTag(BuildContext context, String text, ThemeData theme) {
  return Container(
    margin: const EdgeInsets.only(left: 6),
    padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1.5),
    decoration: BoxDecoration(
      color: theme.colorScheme.outline.withAlpha(20),
      border: Border.all(
        color: theme.colorScheme.outline.withAlpha(100),
        width: 0.5,
      ),
      borderRadius: BorderRadius.circular(6),
    ),
    child: Text(
      text,
      style: TextStyle(
        color: theme.colorScheme.outline,
        fontSize: 9,
        fontWeight: AppTheme.fontWeightBold,
        letterSpacing: 0.5,
      ),
    ),
  );
}

String _songKey(Song song) =>
    '${song.mixSongId}:${song.fileId ?? 0}:${song.hash}:${song.name}';

String _formatDuration(int seconds) {
  final minutes = (seconds / 60).floor();
  final remain = seconds % 60;
  return '${minutes.toString().padLeft(2, '0')}:${remain.toString().padLeft(2, '0')}';
}
