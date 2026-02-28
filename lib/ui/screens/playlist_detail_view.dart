import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import 'package:intl/intl.dart';
import '../../api/music_api.dart';
import '../../models/playlist.dart';
import '../../models/song.dart';
import 'package:echomusic/providers/audio_provider.dart';
import 'package:echomusic/providers/user_provider.dart';
import 'package:echomusic/providers/refresh_provider.dart';
import '../widgets/cover_image.dart';
import '../widgets/custom_toast.dart';
import '../widgets/song_list_scaffold.dart';

class PlaylistDetailView extends StatefulWidget {
  final Playlist playlist;
  const PlaylistDetailView({super.key, required this.playlist});

  @override
  State<PlaylistDetailView> createState() => _PlaylistDetailViewState();
}

class _PlaylistDetailViewState extends State<PlaylistDetailView> with RefreshableState {
  List<Song>? _songs;
  Playlist? _detailedPlaylist;
  bool _isLoading = true;
  late UserProvider _userProvider;

  @override
  void initState() {
    super.initState();
    _userProvider = context.read<UserProvider>();
    _userProvider.playlistSongsChangeNotifier.addListener(_onPlaylistSongsChanged);
    _loadData();
  }

  @override
  void onRefresh() {
    _loadData();
  }

  @override
  void dispose() {
    _userProvider.playlistSongsChangeNotifier.removeListener(_onPlaylistSongsChanged);
    super.dispose();
  }

  Future<void> _loadData() async {
    if (!mounted) return;
    if (_songs == null) {
      setState(() => _isLoading = true);
    }
    
    // Fetch detailed info to get creator and timestamps
    final detailJson = await MusicApi.getPlaylistDetail(
      widget.playlist.globalCollectionId ?? widget.playlist.id.toString()
    );
    
    if (detailJson != null && mounted) {
      setState(() {
        _detailedPlaylist = Playlist.fromUserPlaylist(detailJson);
      });
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
      _loadData();
    }
  }

  String _formatTimestamp(int? timestamp) {
    if (timestamp == null || timestamp == 0) return '未知';
    final date = DateTime.fromMillisecondsSinceEpoch(timestamp * 1000);
    return DateFormat('yyyy-MM-dd').format(date);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final userProvider = context.watch<UserProvider>();
    final playlist = _detailedPlaylist ?? widget.playlist;
    final isFavorited = userProvider.isPlaylistFavorited(playlist.id, globalId: playlist.listCreateGid);
    final isCreated = userProvider.isCreatedPlaylist(playlist.id);

    return SongListScaffold(
      songs: _songs ?? [],
      isLoading: _isLoading,
      parentPlaylist: playlist,
      sourceId: playlist.id,
      headers: [
        SliverAppBar(
          backgroundColor: theme.scaffoldBackgroundColor,
          surfaceTintColor: Colors.transparent,
          expandedHeight: 180, 
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
                          url: playlist.pic,
                          width: 32,
                          height: 32,
                          borderRadius: 6,
                          showShadow: false,
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Text(
                            playlist.name,
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
              padding: const EdgeInsets.fromLTRB(24, 0, 24, 0),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.center,
                children: [
                  CoverImage(
                    url: playlist.pic,
                    width: 130,
                    height: 130,
                    borderRadius: 16,
                  ),
                  const SizedBox(width: 24),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Text(
                          'PLAYLIST',
                          style: TextStyle(
                            color: theme.colorScheme.primary,
                            fontSize: 10,
                            fontWeight: FontWeight.w900,
                            letterSpacing: 2.0,
                          ),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          playlist.name,
                          style: theme.textTheme.titleLarge?.copyWith(
                            fontSize: 22,
                            fontWeight: FontWeight.w900,
                            height: 1.1,
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        const SizedBox(height: 8),
                        if (playlist.nickname.isNotEmpty)
                          Padding(
                            padding: const EdgeInsets.only(bottom: 8.0),
                            child: Row(
                              children: [
                                if (playlist.userPic.isNotEmpty)
                                  Padding(
                                    padding: const EdgeInsets.only(right: 8.0),
                                    child: ClipOval(
                                      child: CoverImage(
                                        url: playlist.userPic,
                                        width: 20,
                                        height: 20,
                                        borderRadius: 0,
                                        showShadow: false,
                                      ),
                                    ),
                                  )
                                else
                                  Padding(
                                    padding: const EdgeInsets.only(right: 8.0),
                                    child: Icon(CupertinoIcons.person_circle_fill, size: 20, color: theme.colorScheme.primary.withAlpha(180)),
                                  ),
                                Text(
                                  playlist.nickname,
                                  style: theme.textTheme.bodyMedium?.copyWith(
                                    color: theme.colorScheme.primary,
                                    fontWeight: FontWeight.w800,
                                    fontSize: 13,
                                  ),
                                ),
                                const SizedBox(width: 12),
                                Text(
                                  '${_formatTimestamp(playlist.createTime)} 创建',
                                  style: TextStyle(
                                    color: theme.colorScheme.onSurface.withAlpha(100),
                                    fontSize: 11,
                                    fontWeight: FontWeight.w600,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        if (playlist.intro.isNotEmpty)
                          Padding(
                            padding: const EdgeInsets.only(bottom: 8.0),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  playlist.intro,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: theme.textTheme.bodyMedium?.copyWith(
                                    color: theme.colorScheme.onSurfaceVariant,
                                    fontWeight: FontWeight.w500,
                                    fontSize: 12,
                                    height: 1.4,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        Row(
                          children: [
                            _buildInfoChip(context, CupertinoIcons.music_note_2, '${_songs?.length ?? playlist.count} 首歌曲'),
                            const Spacer(),
                            if (userProvider.isAuthenticated && !isCreated) ...[
                              OutlinedButton.icon(
                                onPressed: () async {
                                  bool success;
                                  if (isFavorited) {
                                    success = await userProvider.unfavoritePlaylist(playlist.id, globalId: playlist.listCreateGid);
                                    if (context.mounted) {
                                      if (success) {
                                        CustomToast.success(context, '已取消收藏');
                                      } else {
                                        CustomToast.error(context, '操作失败');
                                      }
                                    }
                                  } else {
                                    success = await userProvider.favoritePlaylist(
                                      playlist.originalId, 
                                      playlist.name,
                                      listCreateUserid: playlist.listCreateUserid,
                                      listCreateGid: playlist.listCreateGid,
                                      listCreateListid: playlist.listCreateListid,
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
                                icon: Icon(
                                  isFavorited ? CupertinoIcons.heart_fill : CupertinoIcons.heart, 
                                  size: 16,
                                  color: isFavorited ? Colors.red : null,
                                ),
                                label: Text(
                                  '收藏', 
                                  style: TextStyle(
                                    fontSize: 13, 
                                    fontWeight: FontWeight.w700,
                                    color: isFavorited ? Colors.red : null,
                                  )
                                ),
                                style: OutlinedButton.styleFrom(
                                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                                  side: BorderSide(
                                    color: isFavorited ? Colors.red.withAlpha(100) : theme.colorScheme.outlineVariant,
                                  ),
                                  padding: const EdgeInsets.symmetric(horizontal: 16),
                                  minimumSize: const Size(0, 36),
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
                                minimumSize: const Size(0, 36),
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
