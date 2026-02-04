import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import '../../api/music_api.dart';
import '../../models/song.dart';
import 'package:cached_network_image/cached_network_image.dart';
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
  }

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 40, vertical: 30),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '搜索',
            style: TextStyle(
              fontSize: 28,
              fontWeight: FontWeight.w700,
              color: isDark ? Colors.white : Colors.black,
              letterSpacing: -0.5,
            ),
          ),
          const SizedBox(height: 20),
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: _searchController,
                  style: TextStyle(color: isDark ? Colors.white : Colors.black),
                  decoration: InputDecoration(
                    hintText: '搜索音乐、歌手、专辑',
                    hintStyle: TextStyle(color: isDark ? Colors.white30 : Colors.black38),
                    prefixIcon: Icon(CupertinoIcons.search, color: isDark ? Colors.white30 : Colors.black38, size: 20),
                    filled: true,
                    fillColor: isDark ? Colors.white.withAlpha(10) : Colors.black.withAlpha(5),
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(10),
                      borderSide: BorderSide.none,
                    ),
                    contentPadding: const EdgeInsets.symmetric(vertical: 10),
                  ),
                  onSubmitted: (_) => _onSearch(),
                ),
              ),
              const SizedBox(width: 12),
              CupertinoButton(
                padding: EdgeInsets.zero,
                onPressed: _onSearch,
                child: const Text('搜索'),
              ),
            ],
          ),
          const SizedBox(height: 20),
          TabBar(
            controller: _tabController,
            isScrollable: true,
            indicatorSize: TabBarIndicatorSize.label,
            dividerColor: Colors.transparent,
            labelStyle: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14),
            unselectedLabelStyle: const TextStyle(fontWeight: FontWeight.w400, fontSize: 14),
            indicator: UnderlineTabIndicator(
              borderSide: BorderSide(
                width: 3,
                color: isDark ? Colors.white : Theme.of(context).primaryColor,
              ),
            ),
            tabs: const [
              Tab(text: '单曲'),
              Tab(text: '歌单'),
              Tab(text: '专辑'),
              Tab(text: '歌手'),
            ],
          ),
          const SizedBox(height: 20),
          Expanded(
            child: _isLoading
                ? const Center(child: CupertinoActivityIndicator())
                : TabBarView(
                    controller: _tabController,
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
    final isDark = Theme.of(context).brightness == Brightness.dark;
    if (_songResults.isEmpty) return Center(child: Text('暂无搜索结果', style: TextStyle(color: isDark ? Colors.white30 : Colors.black38)));
    return ListView.builder(
      itemCount: _songResults.length,
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
    final isDark = Theme.of(context).brightness == Brightness.dark;
    if (_playlistResults.isEmpty) return Center(child: Text('暂无搜索结果', style: TextStyle(color: isDark ? Colors.white30 : Colors.black38)));
    return ListView.builder(
      itemCount: _playlistResults.length,
      itemBuilder: (context, index) {
        final item = _playlistResults[index];
        final playlist = Playlist.fromJson({
          'suid': item['suid'],
          'specialid': item['specialid'],
          'specialname': item['specialname'],
          'nickname': item['nickname'],
          'img': item['img'],
          'gid': item['gid'],
          'intro': item['intro'],
          'song_count': item['song_count'],
          'publish_time': item['publish_time'],
        });

        return ListTile(
          contentPadding: EdgeInsets.zero,
          leading: ClipRRect(
            borderRadius: BorderRadius.circular(6),
            child: CachedNetworkImage(
              imageUrl: playlist.pic,
              width: 44,
              height: 44,
              fit: BoxFit.cover,
              errorWidget: (_, __, ___) => const Icon(CupertinoIcons.music_note_list),
            ),
          ),
          title: Text(playlist.name, style: TextStyle(color: isDark ? Colors.white : Colors.black, fontSize: 14, fontWeight: FontWeight.w500)),
          subtitle: Text('${playlist.count} 首歌曲', style: TextStyle(color: isDark ? Colors.white54 : Colors.black54, fontSize: 12)),
          onTap: () {
            Navigator.push(context, CupertinoPageRoute(builder: (_) => PlaylistDetailView(playlist: playlist)));
          },
        );
      },
    );
  }

  Widget _buildAlbumList() {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    if (_albumResults.isEmpty) return Center(child: Text('暂无搜索结果', style: TextStyle(color: isDark ? Colors.white30 : Colors.black38)));
    return ListView.builder(
      itemCount: _albumResults.length,
      itemBuilder: (context, index) {
        final album = _albumResults[index];
        String cover = album['imgurl']?.replaceAll('{size}', '200') ?? '';
        
        return ListTile(
          contentPadding: EdgeInsets.zero,
          leading: ClipRRect(
            borderRadius: BorderRadius.circular(6),
            child: CachedNetworkImage(
              imageUrl: cover,
              width: 44,
              height: 44,
              fit: BoxFit.cover,
              errorWidget: (_, __, ___) => const Icon(CupertinoIcons.layers_fill),
            ),
          ),
          title: Text(album['albumname'] ?? '', style: TextStyle(color: isDark ? Colors.white : Colors.black, fontSize: 14, fontWeight: FontWeight.w500)),
          subtitle: Text(album['singername'] ?? '', style: TextStyle(color: isDark ? Colors.white54 : Colors.black54, fontSize: 12)),
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
    final isDark = Theme.of(context).brightness == Brightness.dark;
    if (_artistResults.isEmpty) return Center(child: Text('暂无搜索结果', style: TextStyle(color: isDark ? Colors.white30 : Colors.black38)));
    return ListView.builder(
      itemCount: _artistResults.length,
      itemBuilder: (context, index) {
        final artist = _artistResults[index];
        String avatar = artist['imgurl']?.replaceAll('{size}', '200') ?? '';
        
        return ListTile(
          contentPadding: EdgeInsets.zero,
          leading: CircleAvatar(
            radius: 22,
            backgroundImage: avatar.isNotEmpty ? CachedNetworkImageProvider(avatar) : null,
            child: avatar.isEmpty ? const Icon(CupertinoIcons.person_fill) : null,
          ),
          title: Text(artist['singername'] ?? '', style: TextStyle(color: isDark ? Colors.white : Colors.black, fontSize: 14, fontWeight: FontWeight.w500)),
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
}
