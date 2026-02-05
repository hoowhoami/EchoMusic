import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import '../../api/music_api.dart';
import '../../models/song.dart';
import '../../providers/selection_provider.dart';
import '../widgets/cover_image.dart';
import 'artist_detail_view.dart';
import 'playlist_detail_view.dart';
import 'album_detail_view.dart';
import '../../models/playlist.dart';
import '../widgets/song_card.dart';
import '../widgets/batch_action_bar.dart';

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

  List<String> _hotSearches = [];
  String _defaultKeyword = '';
  bool _isLoading = false;
  bool _isLoadingHot = true;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 4, vsync: this);
    _loadHotSearches();
  }

  Future<void> _loadHotSearches() async {
    setState(() {
      _isLoadingHot = true;
    });

    try {
      final hot = await MusicApi.getSearchHot();
      final defaultKeyword = await MusicApi.getSearchDefault();
      setState(() {
        _hotSearches = hot;
        _defaultKeyword = defaultKeyword;
        _isLoadingHot = false;
      });
    } catch (e) {
      setState(() {
        _isLoadingHot = false;
      });
    }
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
    final selectionProvider = context.watch<SelectionProvider>();

    return Column(
      children: [
        Expanded(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 40, vertical: 32),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Text(
                      '搜索',
                      style: theme.textTheme.titleLarge?.copyWith(fontSize: 22, letterSpacing: -0.5),
                    ),
                    const Spacer(),
                    if (_songResults.isNotEmpty &&
                        _searchController.text.isNotEmpty &&
                        !_isLoading &&
                        !selectionProvider.isSelectionMode &&
                        _tabController.index == 0)
                      IconButton(
                        icon: const Icon(CupertinoIcons.checkmark_circle, size: 22),
                        onPressed: () {
                          selectionProvider.setSongList(_songResults);
                          selectionProvider.enterSelectionMode();
                        },
                        color: theme.colorScheme.onSurfaceVariant,
                        tooltip: '批量选择',
                      ),
                  ],
                ),
                const SizedBox(height: 24),
                Container(
                  height: 44,
                  decoration: BoxDecoration(
                    color: theme.colorScheme.onSurface.withAlpha(10),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Row(
                    children: [
                      const SizedBox(width: 12),
                      Icon(CupertinoIcons.search, color: theme.colorScheme.onSurface.withAlpha(100), size: 18),
                      const SizedBox(width: 8),
                      Expanded(
                        child: TextField(
                          controller: _searchController,
                          style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w500),
                          decoration: InputDecoration(
                            hintText: _defaultKeyword.isNotEmpty ? '搜索: $_defaultKeyword' : '搜索音乐、歌手、专辑',
                            hintStyle: TextStyle(color: theme.colorScheme.onSurface.withAlpha(80)),
                            border: InputBorder.none,
                            contentPadding: const EdgeInsets.symmetric(vertical: 10),
                          ),
                          onChanged: (_) => setState(() {}),
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
                          color: theme.colorScheme.onSurface.withAlpha(60),
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
                            foregroundColor: theme.colorScheme.onPrimary,
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
                  unselectedLabelColor: theme.colorScheme.onSurfaceVariant,
                  labelStyle: const TextStyle(fontWeight: FontWeight.w700, fontSize: 14),
                  unselectedLabelStyle: const TextStyle(fontWeight: FontWeight.w600, fontSize: 14),
                  indicator: UnderlineTabIndicator(
                    borderSide: BorderSide(
                      width: 2,
                      color: theme.colorScheme.primary,
                    ),
                    borderRadius: BorderRadius.circular(2),
                  ),
                  onTap: (_) => setState(() {}),
                  tabs: const [
                    Tab(text: '单曲'),
                    Tab(text: '歌单'),
                    Tab(text: '专辑'),
                    Tab(text: '歌手'),
                  ],
                ),
                const SizedBox(height: 16),
                Expanded(
                  child: _searchController.text.isEmpty
                      ? _buildHotSearches()
                      : _isLoading
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
          ),
        ),
        const BatchActionBar(),
      ],
    );
  }

  Widget _buildSongList() {
    if (_songResults.isEmpty) return _buildEmptyState();

    final selectionProvider = context.watch<SelectionProvider>();

    return ListView.builder(
      physics: const BouncingScrollPhysics(),
      itemCount: _songResults.length,
      padding: EdgeInsets.zero,
      itemBuilder: (context, index) {
        final song = _songResults[index];
        return SongCard(
          song: song,
          playlist: _songResults,
          showMore: true,
          isSelectionMode: selectionProvider.isSelectionMode,
          isSelected: selectionProvider.isSelected(song.hash),
          onSelectionChanged: (selected) {
            selectionProvider.toggleSelection(song.hash);
          },
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
    final theme = Theme.of(context);
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
              border: Border.all(color: theme.dividerColor, width: 0.5),
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
    final theme = Theme.of(context);
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(CupertinoIcons.search, size: 64, color: theme.colorScheme.onSurface.withAlpha(40)),
          const SizedBox(height: 16),
          Text(
            '暂无搜索结果',
            style: TextStyle(color: theme.colorScheme.onSurface.withAlpha(100), fontWeight: FontWeight.w500),
          ),
        ],
      ),
    );
  }

  Widget _buildHotSearches() {
    if (_isLoadingHot) {
      return const Center(child: CupertinoActivityIndicator());
    }

    if (_hotSearches.isEmpty) {
      return const SizedBox.shrink();
    }

    final theme = Theme.of(context);

    return ListView(
      padding: const EdgeInsets.symmetric(horizontal: 16),
      children: [
        Text(
          '热门搜索',
          style: TextStyle(
            fontSize: 16,
            fontWeight: FontWeight.w700,
            color: theme.colorScheme.onSurface,
          ),
        ),
        const SizedBox(height: 16),
        Wrap(
          spacing: 12,
          runSpacing: 12,
          children: _hotSearches.map((keyword) {
            return GestureDetector(
              onTap: () {
                _searchController.text = keyword;
                _onSearch();
              },
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                decoration: BoxDecoration(
                  color: theme.colorScheme.onSurface.withAlpha(10),
                  borderRadius: BorderRadius.circular(20),
                  border: Border.all(
                    color: theme.colorScheme.outlineVariant,
                    width: 0.8,
                  ),
                ),
                child: Text(
                  keyword,
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w500,
                    color: theme.colorScheme.onSurface,
                  ),
                ),
              ),
            );
          }).toList(),
        ),
      ],
    );
  }
}