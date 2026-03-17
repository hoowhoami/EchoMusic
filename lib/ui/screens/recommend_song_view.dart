import 'dart:async';
import 'package:flutter/material.dart';
import '../../api/music_api.dart';
import '../../models/song.dart';
import 'package:provider/provider.dart';
import '../widgets/song_list_scaffold.dart';
import '../widgets/detail_page_sliver_header.dart';
import '../widgets/detail_page_action_row.dart';
import '../../providers/audio_provider.dart';
import '../widgets/custom_toast.dart';
import '../../providers/persistence_provider.dart';
import 'package:echomusic/theme/app_theme.dart';

class RecommendSongView extends StatefulWidget {
  const RecommendSongView({super.key});

  @override
  State<RecommendSongView> createState() => _RecommendSongViewState();
}

class _RecommendSongViewState extends State<RecommendSongView> {
  late Future<List<Song>> _recommendSongsFuture;

  @override
  void initState() {
    super.initState();
    _recommendSongsFuture = MusicApi.getEverydayRecommend();
  }

  @override
  void dispose() {
    super.dispose();
  }

  void _playRecommendSongs(List<Song> songs) {
    if (songs.isEmpty) return;
    final firstPlayableIndex = songs.indexWhere((song) => song.isPlayable);
    if (firstPlayableIndex == -1) {
      CustomToast.error(context, '当前推荐暂无可播放歌曲');
      return;
    }
    unawaited(_replacePlaybackWithRecommendSongs(songs[firstPlayableIndex], songs));
  }

  Future<void> _replacePlaybackWithRecommendSongs(
    Song song,
    List<Song> songs,
  ) async {
    if (songs.isEmpty) return;
    if (!songs.any((entry) => entry.isPlayable)) {
      CustomToast.error(context, '当前推荐暂无可播放歌曲');
      return;
    }

    final audioProvider = context.read<AudioProvider>();
    unawaited(audioProvider.playSong(song, playlist: songs));
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<List<Song>>(
      future: _recommendSongsFuture,
      builder: (context, snapshot) {
        final songs = snapshot.data ?? [];
        final replacePlaylistEnabled =
            context.select<PersistenceProvider, bool>(
          (provider) => provider.settings['replacePlaylist'] ?? false,
        );
        final theme = Theme.of(context);

        return SongListScaffold(
          songs: songs,
          isLoading: snapshot.connectionState == ConnectionState.waiting,
          hasCommentsTab: false,
          enableDefaultDoubleTapPlay: true,
          onSongDoubleTapPlay: replacePlaylistEnabled
              ? (song) async {
                  await _replacePlaybackWithRecommendSongs(song, songs);
                }
              : null,
          headers: [
            DetailPageSliverHeader(
              typeLabel: 'RECOMMEND',
              title: '每日推荐',
              expandedHeight: 200,
              expandedCover: _buildExpandedCover(context),
              collapsedCover: _buildCollapsedCover(context),
              detailChildren: [
                Text(
                  '为你量身定制的每日歌单',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: theme.colorScheme.onSurfaceVariant.withAlpha(180),
                    fontSize: 12,
                    fontWeight: AppTheme.fontWeightMedium,
                  ),
                ),
              ],
              actions: DetailPageActionRow(
                playLabel: '播放',
                onPlay: () => _playRecommendSongs(songs),
                songs: songs,
              ),
            ),
          ],
        );
      },
    );
  }

  Widget _buildExpandedCover(BuildContext context) {
    return Container(
      width: 136,
      height: 136,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(24),
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [
            Theme.of(context).colorScheme.primary.withAlpha(220),
            Theme.of(context).colorScheme.secondary.withAlpha(180),
          ],
        ),
      ),
      child: Center(
        child: Text(
          '${DateTime.now().day}',
          style: const TextStyle(
            fontSize: 48,
            fontWeight: AppTheme.fontWeightBold,
            color: Colors.white,
          ),
        ),
      ),
    );
  }

  Widget _buildCollapsedCover(BuildContext context) {
    return Container(
      width: 32,
      height: 32,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(8),
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [
            Theme.of(context).colorScheme.primary.withAlpha(200),
            Theme.of(context).colorScheme.secondary.withAlpha(160),
          ],
        ),
      ),
      child: Center(
        child: Text(
          '${DateTime.now().day}',
          style: const TextStyle(
            fontSize: 12,
            fontWeight: AppTheme.fontWeightBold,
            color: Colors.white,
          ),
        ),
      ),
    );
  }
}
