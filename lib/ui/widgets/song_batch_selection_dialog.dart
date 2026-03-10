import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../models/song.dart';
import '../../providers/audio_provider.dart';
import '../../providers/user_provider.dart';
import 'cover_image.dart';
import 'custom_dialog.dart';
import 'custom_toast.dart';
import 'song_table_layout.dart';

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
    barrierColor: Colors.black.withAlpha(120),
    pageBuilder: (_, _, _) => _SongBatchSelectionDialog(
      songs: songs,
      sourceId: sourceId,
    ),
    transitionBuilder: (context, animation, _, child) {
      final curved = CurvedAnimation(parent: animation, curve: Curves.easeOutCubic);
      return FadeTransition(
        opacity: curved,
        child: ScaleTransition(
          scale: Tween<double>(begin: 0.98, end: 1).animate(curved),
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
      final songs = await (widget.onResolveSongs?.call() ?? Future.value(widget.songs));
      if (!mounted || songs.isEmpty) return;
      await showSongBatchSelectionDialog(context, songs: songs, sourceId: widget.sourceId);
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
  State<_SongBatchSelectionDialog> createState() => _SongBatchSelectionDialogState();
}

class _SongBatchSelectionDialogState extends State<_SongBatchSelectionDialog> {
  final Set<String> _selectedKeys = <String>{};

  List<Song> get _selectedSongs =>
      widget.songs.where((song) => _selectedKeys.contains(_songKey(song))).toList();

  bool get _allSelected => widget.songs.isNotEmpty && _selectedKeys.length == widget.songs.length;

  bool? get _selectAllValue => _allSelected ? true : (_selectedKeys.isEmpty ? false : null);

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
    final firstPlayableIndex = _selectedSongs.indexWhere((song) => song.isPlayable);
    if (firstPlayableIndex == -1) {
      CustomToast.error(context, '所选歌曲暂无可用音源');
      return;
    }
    await context.read<AudioProvider>().playSong(
      _selectedSongs[firstPlayableIndex],
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
    final playlist = await showDialog<Map<String, dynamic>>(
      context: context,
      builder: (dialogContext) => _PlaylistPickerDialog(playlists: userProvider.createdPlaylists),
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
    final count = await userProvider.removeSongsFromPlaylist(widget.sourceId, _selectedSongs);
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
    final hasSelection = _selectedKeys.isNotEmpty;
    final canAdd = hasSelection && userProvider.isAuthenticated;
    final canDelete = hasSelection &&
        userProvider.isAuthenticated &&
        widget.sourceId != null &&
        userProvider.isCreatedPlaylist(widget.sourceId);

    return Material(
      color: Colors.transparent,
      child: SafeArea(
        minimum: const EdgeInsets.all(0),
        child: SizedBox.expand(
          child: Container(
            decoration: BoxDecoration(
              color: theme.colorScheme.surface,
              borderRadius: BorderRadius.zero,
              border: Border.all(color: theme.colorScheme.outlineVariant.withAlpha(90), width: 0.6),
              boxShadow: [
                BoxShadow(color: Colors.black.withAlpha(26), blurRadius: 18, offset: const Offset(0, 8)),
              ],
            ),
            child: Column(
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 14, 16, 10),
                  child: Row(
                    children: [
                      Checkbox(
                        value: _selectAllValue,
                        tristate: true,
                        onChanged: widget.songs.isEmpty ? null : _toggleSelectAll,
                        visualDensity: const VisualDensity(horizontal: -4, vertical: -4),
                        materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                      ),
                      const SizedBox(width: 6),
                      const Text('全选', style: TextStyle(fontSize: 12, fontWeight: FontWeight.w700)),
                      const SizedBox(width: 12),
                      Text(
                        '共 ${widget.songs.length} 首 / 已选 ${_selectedSongs.length} 首',
                        style: TextStyle(
                          color: theme.colorScheme.onSurfaceVariant,
                          fontWeight: FontWeight.w600,
                          fontSize: 12,
                        ),
                      ),
                      const Spacer(),
                      FilledButton.icon(
                        onPressed: hasSelection ? _playSelected : null,
                        icon: const Icon(CupertinoIcons.play_fill, size: 16),
                        label: const Text('播放'),
                        style: _buildDialogActionStyle(context),
                      ),
                      const SizedBox(width: 6),
                      FilledButton.icon(
                        onPressed: canAdd ? _addToPlaylist : null,
                        icon: const Icon(CupertinoIcons.add, size: 16),
                        label: const Text('添加到'),
                        style: _buildDialogActionStyle(context),
                      ),
                      const SizedBox(width: 6),
                      FilledButton.icon(
                        onPressed: canDelete ? _deleteSelected : null,
                        icon: const Icon(CupertinoIcons.delete, size: 16),
                        label: const Text('删除'),
                        style: _buildDialogActionStyle(context),
                      ),
                      const SizedBox(width: 10),
                      FilledButton(
                        onPressed: () => Navigator.of(context).pop(),
                        style: _buildDialogActionStyle(context),
                        child: const Text('完成'),
                      ),
                    ],
                  ),
                ),
                Divider(height: 1, color: theme.colorScheme.outlineVariant.withAlpha(120)),
                Expanded(
                  child: ListView.separated(
                    padding: const EdgeInsets.fromLTRB(14, 0, 14, 10),
                    itemCount: widget.songs.length,
                    separatorBuilder: (_, _) => Divider(height: 1, color: theme.colorScheme.outlineVariant.withAlpha(80)),
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
    );
  }
}

class _PlaylistPickerDialog extends StatelessWidget {
  final List<Map<String, dynamic>> playlists;

  const _PlaylistPickerDialog({required this.playlists});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Center(
      child: Material(
        color: Colors.transparent,
        child: Container(
          width: 420,
          constraints: const BoxConstraints(maxHeight: 520),
          padding: const EdgeInsets.fromLTRB(20, 20, 20, 12),
          decoration: BoxDecoration(
            color: theme.colorScheme.surface,
            borderRadius: BorderRadius.circular(20),
          ),
          child: playlists.isEmpty
              ? const Padding(
                  padding: EdgeInsets.symmetric(vertical: 24),
                  child: Text('暂无可用歌单'),
                )
              : Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('添加到歌单', style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
                    const SizedBox(height: 12),
                    Flexible(
                      child: ListView.builder(
                        shrinkWrap: true,
                        itemCount: playlists.length,
                        itemBuilder: (context, index) {
                          final playlist = playlists[index];
                          return ListTile(
                            dense: true,
                            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                            title: Text((playlist['specialname'] ?? playlist['name'] ?? '未命名歌单').toString()),
                            subtitle: Text('${playlist['count'] ?? 0} 首歌曲'),
                            onTap: () => Navigator.of(context).pop(playlist),
                          );
                        },
                      ),
                    ),
                  ],
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
    padding: const EdgeInsets.symmetric(horizontal: 12),
    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
    textStyle: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700),
  );
}

class _BatchSongTile extends StatelessWidget {
  final Song song;
  final bool selected;
  final VoidCallback onTap;

  const _BatchSongTile({required this.song, required this.selected, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
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
                    visualDensity: const VisualDensity(horizontal: -4, vertical: -4),
                    materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
                  ),
                  const SizedBox(width: 8),
                  CoverImage(url: song.cover, width: 38, height: 38, borderRadius: 8, showShadow: false, size: 160),
                  const SizedBox(width: 10),
                ],
              ),
            ),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(song.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700, height: 1.1)),
                  const SizedBox(height: 4),
                  Text(song.singerName, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 11, height: 1.1, color: theme.colorScheme.onSurfaceVariant)),
                ],
              ),
            ),
            const SizedBox(width: SongTableLayout.batchAlbumGap),
            SizedBox(
              width: SongTableLayout.batchAlbumWidth,
              child: Text(song.displayAlbumName, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 11, color: theme.colorScheme.onSurfaceVariant)),
            ),
            const SizedBox(width: SongTableLayout.batchDurationGap),
            SizedBox(
              width: SongTableLayout.batchDurationWidth,
              child: Align(
                alignment: Alignment.centerRight,
                child: Text(_formatDuration(song.duration), style: TextStyle(fontSize: 11, fontFamily: 'monospace', color: theme.colorScheme.onSurfaceVariant)),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

String _songKey(Song song) => '${song.mixSongId}:${song.fileId ?? 0}:${song.hash}:${song.name}';

String _formatDuration(int seconds) {
  final minutes = (seconds / 60).floor();
  final remain = seconds % 60;
  return '${minutes.toString().padLeft(2, '0')}:${remain.toString().padLeft(2, '0')}';
}