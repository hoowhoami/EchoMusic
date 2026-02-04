import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:cached_network_image/cached_network_image.dart';
import 'package:provider/provider.dart';
import '../../api/music_api.dart';
import '../../models/song.dart';
import '../../models/playlist.dart';
import '../../providers/selection_provider.dart';
import 'playlist_detail_view.dart';
import 'rank_view.dart';
import 'album_detail_view.dart';
import '../widgets/song_card.dart';
import '../widgets/batch_action_bar.dart';

class DiscoverView extends StatelessWidget {
  const DiscoverView({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isDark = theme.brightness == Brightness.dark;

    return DefaultTabController(
      length: 4,
      child: Scaffold(
        backgroundColor: Colors.transparent,
        appBar: PreferredSize(
          preferredSize: const Size.fromHeight(80),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(40, 10, 40, 0),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  '发现音乐',
                  style: theme.textTheme.titleLarge?.copyWith(fontSize: 20),
                ),
                const SizedBox(height: 8),
                TabBar(
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
                  ),
                  tabs: const [
                    Tab(text: '歌单'),
                    Tab(text: '排行榜'),
                    Tab(text: '新碟上架'),
                    Tab(text: '新歌速递'),
                  ],
                ),
              ],
            ),
          ),
        ),
        body: const TabBarView(
          physics: BouncingScrollPhysics(),
          children: [
            _DiscoverPlaylistTab(),
            RankView(),
            _DiscoverAlbumTab(),
            _DiscoverSongTab(),
          ],
        ),
      ),
    );
  }
}

class _DiscoverPlaylistTab extends StatefulWidget {
  const _DiscoverPlaylistTab();

  @override
  State<_DiscoverPlaylistTab> createState() => _DiscoverPlaylistTabState();
}

class _DiscoverPlaylistTabState extends State<_DiscoverPlaylistTab> {
  List<Playlist> _playlists = [];
  List<Map<String, dynamic>> _categories = [];
  String _selectedCategoryId = '0';
  String _selectedCategoryName = '全部分类';
  bool _isLoading = true;

  @override
  void initState() {
    super.initState();
    _loadInitialData();
  }

  Future<void> _loadInitialData() async {
    final categories = await MusicApi.getPlaylistCategory();
    if (mounted) {
      setState(() {
        _categories = categories;
      });
      _loadPlaylists('0');
    }
  }

  Future<void> _loadPlaylists(String categoryId) async {
    setState(() {
      _isLoading = true;
      _selectedCategoryId = categoryId;
    });
    final playlists = await MusicApi.getPlaylistByCategory(categoryId);
    if (mounted) {
      setState(() {
        _playlists = playlists;
        _isLoading = false;
      });
    }
  }

  void _showCategoryPicker(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    
    showModalBottomSheet(
      context: context,
      backgroundColor: Colors.transparent,
      isScrollControlled: true,
      builder: (context) {
        return Container(
          height: MediaQuery.of(context).size.height * 0.7,
          decoration: BoxDecoration(
            color: isDark ? const Color(0xFF1E293B) : Colors.white,
            borderRadius: const BorderRadius.vertical(top: Radius.circular(24)),
          ),
          child: Column(
            children: [
              const SizedBox(height: 12),
              Container(
                width: 40,
                height: 4,
                decoration: BoxDecoration(
                  color: isDark ? Colors.white10 : Colors.black12,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
              const Padding(
                padding: EdgeInsets.all(24.0),
                child: Text(
                  '歌单分类',
                  style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
                ),
              ),
              Expanded(
                child: ListView.builder(
                  padding: const EdgeInsets.symmetric(horizontal: 24),
                  itemCount: _categories.length,
                  itemBuilder: (context, index) {
                    final category = _categories[index];
                    final sons = (category['son'] as List?)?.cast<Map<String, dynamic>>() ?? [];
                    
                    return Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Padding(
                          padding: const EdgeInsets.symmetric(vertical: 12),
                          child: Text(
                            category['tag_name'] ?? '',
                            style: TextStyle(
                              color: Theme.of(context).primaryColor,
                              fontWeight: FontWeight.bold,
                              fontSize: 15,
                            ),
                          ),
                        ),
                        Wrap(
                          spacing: 12,
                          runSpacing: 12,
                          children: sons.map((son) {
                            final isSelected = son['tag_id'].toString() == _selectedCategoryId;
                            return InkWell(
                              onTap: () {
                                setState(() {
                                  _selectedCategoryName = son['tag_name'];
                                });
                                Navigator.pop(context);
                                _loadPlaylists(son['tag_id'].toString());
                              },
                              borderRadius: BorderRadius.circular(12),
                              child: Container(
                                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                                decoration: BoxDecoration(
                                  color: isSelected 
                                    ? Theme.of(context).primaryColor.withAlpha(20)
                                    : (isDark ? Colors.white.withAlpha(5) : Colors.black.withAlpha(5)),
                                  borderRadius: BorderRadius.circular(12),
                                  border: Border.all(
                                    color: isSelected 
                                      ? Theme.of(context).primaryColor.withAlpha(100)
                                      : Colors.transparent
                                  ),
                                ),
                                child: Text(
                                  son['tag_name'] ?? '',
                                  style: TextStyle(
                                    fontSize: 13,
                                    fontWeight: isSelected ? FontWeight.bold : FontWeight.normal,
                                    color: isSelected ? Theme.of(context).primaryColor : (isDark ? Colors.white70 : Colors.black87),
                                  ),
                                ),
                              ),
                            );
                          }).toList(),
                        ),
                        const SizedBox(height: 16),
                      ],
                    );
                  },
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;

    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 40, vertical: 10),
          child: Row(
            children: [
              InkWell(
                onTap: () => _showCategoryPicker(context),
                borderRadius: BorderRadius.circular(20),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                  decoration: BoxDecoration(
                    color: isDark ? Colors.white.withAlpha(10) : Colors.black.withAlpha(5),
                    borderRadius: BorderRadius.circular(20),
                    border: Border.all(color: isDark ? Colors.white10 : Colors.black12),
                  ),
                  child: Row(
                    children: [
                      Text(
                        _selectedCategoryName,
                        style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
                      ),
                      const SizedBox(width: 8),
                      Icon(CupertinoIcons.chevron_right, size: 12, color: isDark ? Colors.white38 : Colors.black38),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
        Expanded(
          child: _isLoading
            ? const Center(child: CupertinoActivityIndicator())
            : GridView.builder(
                padding: const EdgeInsets.symmetric(horizontal: 40, vertical: 10),
                gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                  crossAxisCount: 5,
                  childAspectRatio: 0.75,
                  crossAxisSpacing: 24,
                  mainAxisSpacing: 24,
                ),
                itemCount: _playlists.length,
                itemBuilder: (context, index) {
                  final playlist = _playlists[index];
                  return _PlaylistCard(playlist: playlist);
                },
              ),
        ),
      ],
    );
  }
}

class _PlaylistCard extends StatelessWidget {
  final Playlist playlist;
  const _PlaylistCard({required this.playlist});

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;

    return InkWell(
      onTap: () {
        Navigator.push(
          context,
          CupertinoPageRoute(builder: (_) => PlaylistDetailView(playlist: playlist)),
        );
      },
      borderRadius: BorderRadius.circular(10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Container(
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(10),
                boxShadow: [
                  BoxShadow(
                    color: Colors.black.withAlpha(30),
                    blurRadius: 8,
                    offset: const Offset(0, 4),
                  ),
                ],
              ),
                                child: ClipRRect(
                                  borderRadius: BorderRadius.circular(10),
                                  child: CachedNetworkImage(
                                    imageUrl: playlist.pic,
                                    fit: BoxFit.cover,
                                    width: double.infinity,
                                    placeholder: (context, url) => Container(color: isDark ? Colors.white10 : Colors.black12),
                                    errorWidget: (context, url, error) => const Icon(CupertinoIcons.music_note_list),
                                  ),
                                ),            ),
          ),
          const SizedBox(height: 10),
          Text(
            playlist.name,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              color: isDark ? Colors.white.withAlpha(220) : Colors.black.withAlpha(220), 
              fontSize: 13,
              fontWeight: FontWeight.w500,
            ),
          ),
        ],
      ),
    );
  }
}

class _DiscoverAlbumTab extends StatefulWidget {
  const _DiscoverAlbumTab();

  @override
  State<_DiscoverAlbumTab> createState() => _DiscoverAlbumTabState();
}

class _DiscoverAlbumTabState extends State<_DiscoverAlbumTab> {
  late Future<List<Map<String, dynamic>>> _albumsFuture;

  @override
  void initState() {
    super.initState();
    _albumsFuture = MusicApi.getAlbumTop();
  }

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;

    return FutureBuilder<List<Map<String, dynamic>>>(
      future: _albumsFuture,
      builder: (context, snapshot) {
        if (!snapshot.hasData) return const Center(child: CupertinoActivityIndicator());
        final albums = snapshot.data!;
        return GridView.builder(
          padding: const EdgeInsets.symmetric(horizontal: 40, vertical: 20),
          gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
            crossAxisCount: 5,
            childAspectRatio: 0.75,
            crossAxisSpacing: 24,
            mainAxisSpacing: 24,
          ),
          itemCount: albums.length,
          itemBuilder: (context, index) {
            final album = albums[index];
            String cover = album['imgurl']?.replaceAll('{size}', '400') ?? '';
            return InkWell(
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
              borderRadius: BorderRadius.circular(10),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Container(
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(10),
                        boxShadow: [
                          BoxShadow(
                            color: Colors.black.withAlpha(30),
                            blurRadius: 8,
                            offset: const Offset(0, 4),
                          ),
                        ],
                      ),
                      child: ClipRRect(
                        borderRadius: BorderRadius.circular(10),
                        child: CachedNetworkImage(
                          imageUrl: cover,
                          fit: BoxFit.cover,
                          width: double.infinity,
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 10),
                  Text(
                    album['albumname'] ?? '',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      color: isDark ? Colors.white.withAlpha(220) : Colors.black.withAlpha(220), 
                      fontSize: 13, 
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  Text(
                    album['singername'] ?? '',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(color: isDark ? Colors.white38 : Colors.black38, fontSize: 11),
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

class _DiscoverSongTab extends StatefulWidget {
  const _DiscoverSongTab();

  @override
  State<_DiscoverSongTab> createState() => _DiscoverSongTabState();
}

class _DiscoverSongTabState extends State<_DiscoverSongTab> {
  late Future<List<Song>> _songsFuture;

  @override
  void initState() {
    super.initState();
    _songsFuture = MusicApi.getNewSongs();
  }

  @override
  Widget build(BuildContext context) {
    final selectionProvider = context.watch<SelectionProvider>();
    final isDark = Theme.of(context).brightness == Brightness.dark;

    return FutureBuilder<List<Song>>(
      future: _songsFuture,
      builder: (context, snapshot) {
        if (!snapshot.hasData) return const Center(child: CupertinoActivityIndicator());
        final songs = snapshot.data!;

        return Column(
          children: [
            if (songs.isNotEmpty && !selectionProvider.isSelectionMode)
              Padding(
                padding: const EdgeInsets.fromLTRB(40, 10, 40, 0),
                child: Row(
                  children: [
                    const Spacer(),
                    IconButton(
                      icon: const Icon(CupertinoIcons.checkmark_circle, size: 22),
                      onPressed: () {
                        selectionProvider.setSongList(songs);
                        selectionProvider.enterSelectionMode();
                      },
                      color: isDark ? Colors.white54 : Colors.black54,
                      tooltip: '批量选择',
                    ),
                  ],
                ),
              ),
            Expanded(
              child: ListView.builder(
                padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 20),
                itemCount: songs.length,
                itemBuilder: (context, index) {
                  final song = songs[index];
                  return SongCard(
                    song: song,
                    playlist: songs,
                    showMore: true,
                    isSelectionMode: selectionProvider.isSelectionMode,
                    isSelected: selectionProvider.isSelected(song.hash),
                    onSelectionChanged: (selected) {
                      selectionProvider.toggleSelection(song.hash);
                    },
                  );
                },
              ),
            ),
            const BatchActionBar(),
          ],
        );
      },
    );
  }
}


