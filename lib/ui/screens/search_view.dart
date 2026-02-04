import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import '../../api/music_api.dart';
import '../../models/song.dart';
import '../widgets/cover_image.dart';
import 'artist_detail_view.dart';
import 'playlist_detail_view.dart';
import 'album_detail_view.dart';
import '../../models/playlist.dart';
import '../widgets/song_card.dart';

class SearchView extends StatefulWidget {
  const SearchView({super.key});

  @override
  State<SearchView> createState() => _SearchViewState();
}

class _SearchViewState extends State<SearchView> with SingleTickerProviderStateMixin {
  final TextEditingController _searchController = TextEditingController();
  late TabController _tabController;
  
  List<Song> _songResults = [];
  List<Map<String, dynamic>> _albumResults = [];
  List<Map<String, dynamic>> _artistResults = [];
  List<Map<String, dynamic>> _playlistResults = [];
  
  bool _isLoading = false;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 4, vsync: this);
  }

  void _onSearch() async {
    final keywords = _searchController.text.trim();
    if (keywords.isEmpty) return;

    setState(() {
      _isLoading = true;
    });

    try {
      // Search for all types
      final songRes = await MusicApi.search(keywords, type: 'song');
      final albumRes = await MusicApi.getSearchResult(keywords, type: 'album');
      final artistRes = await MusicApi.getSearchResult(keywords, type: 'author');
      final playlistRes = await MusicApi.getSearchResult(keywords, type: 'special');

      setState(() {
        _songResults = songRes;
        _albumResults = (albumRes['data']?['lists'] as List?)?.cast<Map<String, dynamic>>() ?? [];
        _artistResults = (artistRes['data']?['lists'] as List?)?.cast<Map<String, dynamic>>() ?? [];
        _playlistResults = (playlistRes['data']?['lists'] as List?)?.cast<Map<String, dynamic>>() ?? [];
        _isLoading = false;
      });
    } catch (e) {
      setState(() {
        _isLoading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isDark = theme.brightness == Brightness.dark;

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 40, vertical: 32),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '搜索',
            style: theme.textTheme.titleLarge?.copyWith(fontSize: 22, letterSpacing: -0.5),
          ),
          const SizedBox(height: 24),
          Container(
            height: 44,
            decoration: BoxDecoration(
              color: isDark ? Colors.white.withAlpha(5) : Colors.black.withAlpha(5),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Row(
              children: [
                const SizedBox(width: 12),
                Icon(CupertinoIcons.search, color: isDark ? Colors.white38 : Colors.black38, size: 18),
                const SizedBox(width: 8),
                Expanded(
                  child: TextField(
                    controller: _searchController,
                    style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w500),
                    decoration: InputDecoration(
                      hintText: '搜索音乐、歌手、专辑',
                      hintStyle: TextStyle(color: isDark ? Colors.white30 : Colors.black38),
                      border: InputBorder.none,
                      contentPadding: const EdgeInsets.symmetric(vertical: 10),
                    ),
                    onSubmitted: (_) => _onSearch(),
                  ),
                ),
                if (_searchController.text.isNotEmpty)
                  IconButton(
                    icon: const Icon(CupertinoIcons.clear_thick_circled, size: 16),
                    onPressed: () {
                      _searchController.clear();
                      setState(() {});
                    },
                    color: isDark ? Colors.white24 : Colors.black26,
                    padding: EdgeInsets.zero,
                    constraints: const BoxConstraints(),
                  ),
                const SizedBox(width: 8),
                Padding(
                  padding: const EdgeInsets.all(4.0),
                  child: ElevatedButton(
                    onPressed: _onSearch,
                    style: ElevatedButton.styleFrom(
                      backgroundColor: theme.colorScheme.primary,
                      foregroundColor: Colors.white,
                      elevation: 0,
                      padding: const EdgeInsets.symmetric(horizontal: 16),
                      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
                      minimumSize: const Size(0, 36),
                    ),
                    child: const Text('搜索', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 13)),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 24),
          TabBar(
            controller: _tabController,
            isScrollable: true,
            indicatorSize: TabBarIndicatorSize.label,
            dividerColor: Colors.transparent,
            labelColor: theme.colorScheme.primary,
            unselectedLabelColor: isDark ? Colors.white38 : Colors.black38,
            labelStyle: const TextStyle(fontWeight: FontWeight.w700, fontSize: 14),
            unselectedLabelStyle: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14),
            indicator: UnderlineTabIndicator(
              borderSide: BorderSide(
                width: 2,
                color: theme.colorScheme.primary,
              ),
              borderRadius: BorderRadius.circular(2),
            ),
            tabs: const [
              Tab(text: '单曲'),
              Tab(text: '歌单'),
              Tab(text: '专辑'),
              Tab(text: '歌手'),
            ],
          ),
          const SizedBox(height: 16),
          Expanded(
            child: _isLoading
                ? const Center(child: CupertinoActivityIndicator())
                : TabBarView(
                    controller: _tabController,
                    physics: const BouncingScrollPhysics(),
                    children: [
                      _buildSongList(),
                      _buildPlaylistList(),
                      _buildAlbumList(),
                      _buildArtistList(),
                    ],
                  ),
          ),
        ],
      ),
    );
  }

  Widget _buildSongList() {
    if (_songResults.isEmpty) return _buildEmptyState();
    return ListView.builder(
      physics: const BouncingScrollPhysics(),
      itemCount: _songResults.length,
      padding: EdgeInsets.zero,
      itemBuilder: (context, index) {
        return SongCard(
          song: _songResults[index],
          playlist: _songResults,
          showMore: true,
        );
      },
    );
  }

  Widget _buildPlaylistList() {
    if (_playlistResults.isEmpty) return _buildEmptyState();
    return ListView.builder(
      physics: const BouncingScrollPhysics(),
      itemCount: _playlistResults.length,
      padding: EdgeInsets.zero,
      itemBuilder: (context, index) {
        final item = _playlistResults[index];
        final playlist = Playlist.fromJson({
          'specialid': item['specialid'],
          'specialname': item['specialname'],
          'img': item['img'],
          'intro': item['intro'],
          'song_count': item['song_count'],
        });

        return ListTile(
          contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 2),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          leading: CoverImage(
            url: playlist.pic,
            width: 44,
            height: 44,
            borderRadius: 8,
            showShadow: false,
            size: 100,
          ),
          title: Text(
            playlist.name, 
            style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
          subtitle: Text(
            '${playlist.count} 首歌曲', 
            style: Theme.of(context).textTheme.bodyMedium?.copyWith(fontSize: 12),
          ),
          onTap: () {
            Navigator.push(context, CupertinoPageRoute(builder: (_) => PlaylistDetailView(playlist: playlist)));
          },
        );
      },
    );
  }

  Widget _buildAlbumList() {
    if (_albumResults.isEmpty) return _buildEmptyState();
    return ListView.builder(
      physics: const BouncingScrollPhysics(),
      itemCount: _albumResults.length,
      padding: EdgeInsets.zero,
      itemBuilder: (context, index) {
        final album = _albumResults[index];
        String cover = album['imgurl'] ?? '';
        
        return ListTile(
          contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 2),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          leading: CoverImage(
            url: cover,
            width: 44,
            height: 44,
            borderRadius: 8,
            showShadow: false,
            size: 100,
          ),
          title: Text(
            album['albumname'] ?? '', 
            style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
          subtitle: Text(
            album['singername'] ?? '', 
            style: Theme.of(context).textTheme.bodyMedium?.copyWith(fontSize: 12),
          ),
          onTap: () {
            Navigator.push(
              context,
              CupertinoPageRoute(
                builder: (_) => AlbumDetailView(
                  albumId: album['albumid'],
                  albumName: album['albumname'] ?? '',
                ),
              ),
            );
          },
        );
      },
    );
  }

  Widget _buildArtistList() {
    if (_artistResults.isEmpty) return _buildEmptyState();
    return ListView.builder(
      physics: const BouncingScrollPhysics(),
      itemCount: _artistResults.length,
      padding: EdgeInsets.zero,
      itemBuilder: (context, index) {
        final artist = _artistResults[index];
        String avatar = artist['imgurl'] ?? '';
        
        return ListTile(
          contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 2),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          leading: Container(
            width: 44,
            height: 44,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              border: Border.all(color: Theme.of(context).dividerColor, width: 0.5),
            ),
            child: ClipOval(
              child: CoverImage(
                url: avatar,
                width: 44,
                height: 44,
                borderRadius: 0,
                showShadow: false,
                size: 100,
              ),
            ),
          ),
          title: Text(
            artist['singername'] ?? '', 
            style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
          ),
          onTap: () {
            Navigator.push(
              context,
              CupertinoPageRoute(
                builder: (_) => ArtistDetailView(
                  artistId: artist['singerid'],
                  artistName: artist['singername'],
                ),
              ),
            );
          },
        );
      },
    );
  }

  Widget _buildEmptyState() {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(CupertinoIcons.search, size: 64, color: Theme.of(context).dividerColor),
          const SizedBox(height: 16),
          Text(
            '暂无搜索结果',
            style: TextStyle(color: Theme.of(context).dividerColor, fontWeight: FontWeight.w500),
          ),
        ],
      ),
    );
  }
}