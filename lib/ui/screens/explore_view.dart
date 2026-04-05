import 'package:flutter/material.dart';
import '../../api/music_api.dart';
import '../../models/song.dart';
import '../../models/playlist.dart';
import 'package:provider/provider.dart';
import '../../providers/audio_provider.dart';
import '../../providers/navigation_provider.dart';
import '../widgets/playlist_card.dart';
import '../widgets/cover_image.dart';
import 'package:echomusic/theme/app_theme.dart';
import '../widgets/scrollable_content.dart';

class ExploreView extends StatefulWidget {
  const ExploreView({super.key});

  @override
  State<ExploreView> createState() => _ExploreViewState();
}

class _ExploreViewState extends State<ExploreView> {
  late Future<List<Song>> _newSongsFuture;
  late Future<List<Playlist>> _recommendedPlaylistsFuture;

  @override
  void initState() {
    super.initState();
    _newSongsFuture = MusicApi.getNewSongs();
    _recommendedPlaylistsFuture = MusicApi.getRecommendPlaylists();
  }

  @override
  Widget build(BuildContext context) {
    return ScrollableContent(
      padding: const EdgeInsets.fromLTRB(40, 20, 40, 40),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _buildMainHeader('探索发现'),
          const SizedBox(height: 32),
          _buildSectionHeader('推荐歌单'),
          const SizedBox(height: 16),
          _buildRecommendedPlaylists(),
          const SizedBox(height: 20),
          _buildSectionHeader('新歌速递'),
          const SizedBox(height: 16),
          _buildNewSongs(),
        ],
      ),
    );
  }

  Widget _buildMainHeader(String title) {
    final theme = Theme.of(context);
    return Text(
      title,
      style: TextStyle(
        fontSize: 24,
        fontWeight: AppTheme.fontWeightSemiBold,
        color: theme.colorScheme.onSurface,
        letterSpacing: -0.5,
      ),
    );
  }

  Widget _buildSectionHeader(String title) {
    final theme = Theme.of(context);
    return Text(
      title,
      style: TextStyle(
        fontSize: 18,
        fontWeight: AppTheme.fontWeightSemiBold,
        color: theme.colorScheme.onSurface,
      ),
    );
  }

  Widget _buildRecommendedPlaylists() {
    return FutureBuilder<List<Playlist>>(
      future: _recommendedPlaylistsFuture,
      builder: (context, snapshot) {
        if (!snapshot.hasData) return const SizedBox(height: 200);
        final playlists = snapshot.data!;
        return SizedBox(
          height: 220,
          child: ListView.builder(
            scrollDirection: Axis.horizontal,
            itemCount: playlists.length,
            itemBuilder: (context, index) {
              final playlist = playlists[index];
              return Padding(
                padding: const EdgeInsets.only(right: 20),
                child: SizedBox(
                  width: 160,
                  child: PlaylistCard.grid(
                    playlist: playlist,
                    onTap: () =>
                        context.read<NavigationProvider>().openPlaylist(playlist),
                    titleMaxLines: 1,
                    coverRadius: 16,
                    showShadow: false,
                  ),
                ),
              );
            },
          ),
        );
      },
    );
  }

  Widget _buildNewSongs() {
    final theme = Theme.of(context);
    return FutureBuilder<List<Song>>(
      future: _newSongsFuture,
      builder: (context, snapshot) {
        if (!snapshot.hasData) return const Center(child: CircularProgressIndicator());
        final songs = snapshot.data!;
        return GridView.builder(
          shrinkWrap: true,
          physics: const NeverScrollableScrollPhysics(),
          gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
            maxCrossAxisExtent: 200,
            mainAxisExtent: 210,
            mainAxisSpacing: 20,
            crossAxisSpacing: 20,
          ),
          itemCount: songs.length.clamp(0, 10), // Show top 10
          itemBuilder: (context, index) {
            final song = songs[index];
            return InkWell(
              onTap: () {
                context.read<AudioProvider>().playSong(song, playlist: songs);
              },
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: ClipRRect(
                      borderRadius: BorderRadius.circular(16),
                      child: CoverImage(
                        url: song.cover,
                        fit: BoxFit.cover,
                        width: double.infinity,
                        height: double.infinity,
                        showShadow: false,
                        size: 200,
                      ),
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    song.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontWeight: AppTheme.fontWeightSemiBold, color: theme.colorScheme.onSurface, fontSize: 13),
                  ),
                  Text(
                    song.singerName,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(color: theme.colorScheme.onSurfaceVariant, fontSize: 11),
                  ),
                ],
              ),
            );
          },
        );
      },
    );
  }
}
