import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import '../../api/music_api.dart';
import '../../models/playlist.dart';
import '../../models/song.dart';
import '../../providers/audio_provider.dart';
import '../../providers/user_provider.dart';
import '../widgets/cover_image.dart';
import '../widgets/custom_toast.dart';
import '../widgets/song_list_scaffold.dart';

class PlaylistDetailView extends StatefulWidget {
  final Playlist playlist;
  const PlaylistDetailView({super.key, required this.playlist});

  @override
  State<PlaylistDetailView> createState() => _PlaylistDetailViewState();
}

class _PlaylistDetailViewState extends State<PlaylistDetailView> {
  List<Song>? _songs;
  bool _isLoading = true;
  late UserProvider _userProvider;

  @override
  void initState() {
    super.initState();
    _userProvider = context.read<UserProvider>();
    _userProvider.playlistSongsChangeNotifier.addListener(_onPlaylistSongsChanged);
    _loadSongs();
  }

  @override
  void dispose() {
    _userProvider.playlistSongsChangeNotifier.removeListener(_onPlaylistSongsChanged);
    super.dispose();
  }

  Future<void> _loadSongs() async {
    if (!mounted) return;
    if (_songs == null) {
      setState(() => _isLoading = true);
    }
    
    final songs = await MusicApi.getPlaylistSongs(
      widget.playlist.globalCollectionId ?? widget.playlist.id.toString(),
      listid: widget.playlist.listid,
      listCreateGid: widget.playlist.listCreateGid,
      listCreateUserid: widget.playlist.listCreateUserid,
    );

    if (mounted) {
      setState(() {
        _songs = songs;
        _isLoading = false;
      });
    }
  }

  void _onPlaylistSongsChanged() {
    if (!mounted) return;
    final changedListId = _userProvider.playlistSongsChangeNotifier.value;
    if (changedListId == widget.playlist.id || changedListId == widget.playlist.listid) {
      _loadSongs();
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final userProvider = context.watch<UserProvider>();
    final isFavorited = userProvider.isPlaylistFavorited(widget.playlist.id, globalId: widget.playlist.listCreateGid);
    final isCreated = userProvider.isCreatedPlaylist(widget.playlist.id);

    return SongListScaffold(
      songs: _songs ?? [],
      isLoading: _isLoading,
      parentPlaylist: widget.playlist,
      sourceId: widget.playlist.id,
      headers: [
        SliverAppBar(
          backgroundColor: theme.scaffoldBackgroundColor,
          surfaceTintColor: Colors.transparent,
          expandedHeight: 200,
          pinned: true,
          elevation: 0,
          automaticallyImplyLeading: false,
          flexibleSpace: FlexibleSpaceBar(
            titlePadding: EdgeInsets.zero,
            centerTitle: false,
            expandedTitleScale: 1.0,
            title: LayoutBuilder(
              builder: (context, constraints) {
                final double settings = constraints.maxHeight;
                final bool isCollapsed = settings <= kToolbarHeight + 20;
                
                return AnimatedOpacity(
                  duration: const Duration(milliseconds: 200),
                  opacity: isCollapsed ? 1.0 : 0.0,
                  child: Container(
                    height: kToolbarHeight,
                    padding: const EdgeInsets.only(left: 20),
                    child: Row(
                      children: [
                        CoverImage(
                          url: widget.playlist.pic,
                          width: 32,
                          height: 32,
                          borderRadius: 6,
                          showShadow: false,
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Text(
                            widget.playlist.name,
                            style: TextStyle(
                              color: theme.colorScheme.onSurface,
                              fontSize: 16,
                              fontWeight: FontWeight.w900,
                            ),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                      ],
                    ),
                  ),
                );
              },
            ),
            background: Padding(
              padding: const EdgeInsets.fromLTRB(40, 20, 40, 20),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.center,
                children: [
                  CoverImage(
                    url: widget.playlist.pic,
                    width: 140,
                    height: 140,
                    borderRadius: 12,
                  ),
                  const SizedBox(width: 32),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Text(
                          widget.playlist.name,
                          style: theme.textTheme.titleLarge?.copyWith(
                            fontSize: 24,
                            fontWeight: FontWeight.w900,
                            height: 1.2,
                          ),
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                        ),
                        const SizedBox(height: 10),
                        if (widget.playlist.intro.isNotEmpty)
                          Text(
                            widget.playlist.intro,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: theme.textTheme.bodyMedium?.copyWith(
                              color: theme.colorScheme.onSurfaceVariant,
                              fontWeight: FontWeight.w600,
                              fontSize: 13,
                            ),
                          ),
                        const SizedBox(height: 14),
                        Row(
                          children: [
                            _buildInfoChip(context, Icons.play_arrow_rounded, _formatNumber(widget.playlist.playCount)),
                            if (widget.playlist.heat != null) ...[
                              const SizedBox(width: 12),
                              _buildInfoChip(context, Icons.favorite_rounded, _formatNumber(widget.playlist.heat!)),
                            ],
                            const Spacer(),
                            if (userProvider.isAuthenticated && !isCreated) ...[
                              OutlinedButton.icon(
                                onPressed: () async {
                                  bool success;
                                  if (isFavorited) {
                                    success = await userProvider.unfavoritePlaylist(widget.playlist.id, globalId: widget.playlist.listCreateGid);
                                    if (context.mounted) {
                                      if (success) {
                                        CustomToast.success(context, '已取消收藏');
                                      } else {
                                        CustomToast.error(context, '操作失败');
                                      }
                                    }
                                  } else {
                                    success = await userProvider.favoritePlaylist(
                                      widget.playlist.originalId, 
                                      widget.playlist.name,
                                      listCreateUserid: widget.playlist.listCreateUserid,
                                      listCreateGid: widget.playlist.listCreateGid,
                                      listCreateListid: widget.playlist.listCreateListid,
                                    );
                                    if (context.mounted) {
                                      if (success) {
                                        CustomToast.success(context, '已收藏歌单');
                                      } else {
                                        CustomToast.error(context, '收藏失败');
                                      }
                                    }
                                  }
                                },
                                icon: Icon(isFavorited ? CupertinoIcons.heart_fill : CupertinoIcons.heart, size: 16),
                                label: const Text('收藏', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700)),
                                style: OutlinedButton.styleFrom(
                                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                                  side: BorderSide(color: theme.colorScheme.outlineVariant),
                                  padding: const EdgeInsets.symmetric(horizontal: 16),
                                  minimumSize: const Size(0, 40),
                                  tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                                ),
                              ),
                              const SizedBox(width: 12),
                            ],
                            OutlinedButton.icon(
                              onPressed: () async {
                                final songs = _songs ?? [];
                                if (songs.isNotEmpty) {
                                  context.read<AudioProvider>().playSong(songs.first, playlist: songs);
                                }
                              },
                              icon: Icon(CupertinoIcons.play_fill, size: 16, color: theme.colorScheme.primary),
                              label: Text('播放', style: TextStyle(fontSize: 13, fontWeight: FontWeight.w700, color: theme.colorScheme.primary)),
                              style: OutlinedButton.styleFrom(
                                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                                side: BorderSide(color: theme.colorScheme.primary.withAlpha(100)),
                                padding: const EdgeInsets.symmetric(horizontal: 16),
                                minimumSize: const Size(0, 40),
                                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }

  String _formatNumber(int number) {
    if (number < 10000) return number.toString();
    return '${(number / 10000).toStringAsFixed(1)}万';
  }

  Widget _buildInfoChip(BuildContext context, IconData icon, String label) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: theme.colorScheme.onSurface.withAlpha(15),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 12, color: theme.colorScheme.onSurfaceVariant),
          const SizedBox(width: 6),
          Text(
            label,
            style: TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w700,
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
        ],
      ),
    );
  }
}