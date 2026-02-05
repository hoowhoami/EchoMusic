import 'package:flutter/material.dart';
import '../../api/music_api.dart';
import '../../models/song.dart';
import '../../models/playlist.dart';
import 'package:provider/provider.dart';
import '../../providers/audio_provider.dart';
import 'package:cached_network_image/cached_network_image.dart';
import 'playlist_detail_view.dart';

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
    return SingleChildScrollView(
      padding: const EdgeInsets.all(30.0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _buildHeader('推荐歌单'),
          const SizedBox(height: 20),
          _buildRecommendedPlaylists(),
          const SizedBox(height: 40),
          _buildHeader('新歌速递'),
          const SizedBox(height: 20),
          _buildNewSongs(),
        ],
      ),
    );
  }

  Widget _buildHeader(String title) {
    final theme = Theme.of(context);
    return Text(
      title,
      style: TextStyle(
        fontSize: 24,
        fontWeight: FontWeight.bold,
        color: theme.colorScheme.onSurface,
      ),
    );
  }

  Widget _buildRecommendedPlaylists() {
    final theme = Theme.of(context);
    return FutureBuilder<List<Playlist>>(
      future: _recommendedPlaylistsFuture,
      builder: (context, snapshot) {
        if (!snapshot.hasData) return const SizedBox(height: 200);
        final playlists = snapshot.data!;
        return SizedBox(
          height: 240,
          child: ListView.builder(
            scrollDirection: Axis.horizontal,
            itemCount: playlists.length,
            itemBuilder: (context, index) {
              final playlist = playlists[index];
              return Padding(
                padding: const EdgeInsets.only(right: 20),
                child: InkWell(
                  onTap: () {
                    Navigator.push(
                      context,
                      MaterialPageRoute(
                        builder: (_) => PlaylistDetailView(playlist: playlist),
                      ),
                    );
                  },
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      ClipRRect(
                        borderRadius: BorderRadius.circular(12),
                        child: CachedNetworkImage(
                          imageUrl: playlist.pic,
                          width: 180,
                          height: 180,
                          fit: BoxFit.cover,
                        ),
                      ),
                      const SizedBox(height: 10),
                      SizedBox(
                        width: 180,
                        child: Text(
                          playlist.name,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            color: theme.colorScheme.onSurface,
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                      ),
                    ],
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
          gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
            crossAxisCount: 5,
            childAspectRatio: 0.8,
            crossAxisSpacing: 15,
            mainAxisSpacing: 15,
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
                      borderRadius: BorderRadius.circular(12),
                      child: CachedNetworkImage(
                        imageUrl: song.cover,
                        fit: BoxFit.cover,
                        width: double.infinity,
                        errorWidget: (context, url, error) => Icon(Icons.music_note, size: 50, color: theme.colorScheme.onSurfaceVariant),
                      ),
                    ),
                  ),
                  const SizedBox(height: 8),
                  Text(
                    song.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontWeight: FontWeight.bold, color: theme.colorScheme.onSurface),
                  ),
                  Text(
                    song.singerName,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(color: theme.colorScheme.onSurfaceVariant, fontSize: 12),
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