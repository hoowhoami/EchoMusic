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
import '../widgets/refined_picker.dart';
import '../widgets/refined_selector.dart';

class DiscoverView extends StatelessWidget {
  const DiscoverView({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return DefaultTabController(
      length: 4,
      child: Scaffold(
        backgroundColor: theme.scaffoldBackgroundColor,
        appBar: PreferredSize(
          preferredSize: const Size.fromHeight(100),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(40, 10, 40, 0),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
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
                  unselectedLabelColor: theme.colorScheme.onSurfaceVariant,
                  labelStyle: const TextStyle(fontWeight: FontWeight.w800, fontSize: 14),
                  unselectedLabelStyle: const TextStyle(fontWeight: FontWeight.w700, fontSize: 14),
                  indicator: UnderlineTabIndicator(
                    borderSide: BorderSide(
                      width: 2.5,
                      color: theme.colorScheme.primary,
                    ),
                    borderRadius: BorderRadius.circular(2),
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
            RankView(backgroundColor: Colors.transparent),
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
    final List<PickerOption> options = [];
    for (var cat in _categories) {
      final sons = (cat['son'] as List?)?.cast<Map<String, dynamic>>() ?? [];
      for (var son in sons) {
        options.add(PickerOption(
          id: son['tag_id'].toString(),
          name: son['tag_name'],
          group: cat['tag_name'],
        ));
      }
    }

    RefinedPicker.show(
      context,
      title: '歌单分类',
      options: options,
      selectedId: _selectedCategoryId,
      onSelected: (opt) {
        setState(() {
          _selectedCategoryName = opt.name;
        });
        _loadPlaylists(opt.id);
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 40, vertical: 10),
          child: Row(
            children: [
              RefinedSelector(
                label: _selectedCategoryName,
                onTap: () => _showCategoryPicker(context),
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
    final theme = Theme.of(context);

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
                    color: theme.colorScheme.shadow.withAlpha(30),
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
                  placeholder: (context, url) => Container(color: theme.colorScheme.onSurface.withAlpha(10)),
                  errorWidget: (context, url, error) => const Icon(CupertinoIcons.music_note_list),
                ),
              ),
            ),
          ),
          const SizedBox(height: 10),
          Text(
            playlist.name,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              color: theme.colorScheme.onSurface, 
              fontSize: 13,
              fontWeight: FontWeight.w700,
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
  String _selectedTypeId = 'all';
  String _selectedTypeName = '全部';
  Map<String, dynamic> _allAlbums = {};
  bool _isLoading = true;

  final List<Map<String, String>> _types = [
    {'id': 'all', 'name': '全部'},
    {'id': 'chn', 'name': '华语'},
    {'id': 'eur', 'name': '欧美'},
    {'id': 'jpn', 'name': '日本'},
    {'id': 'kor', 'name': '韩国'},
  ];

  @override
  void initState() {
    super.initState();
    _loadAlbums();
  }

  Future<void> _loadAlbums() async {
    setState(() => _isLoading = true);
    final res = await MusicApi.getAlbumTop();
    if (mounted) {
      setState(() {
        _allAlbums = res;
        _isLoading = false;
      });
    }
  }

  List<Map<String, dynamic>> _getFilteredAlbums() {
    if (_selectedTypeId == 'all') {
      List<Map<String, dynamic>> combined = [];
      for (var type in _types) {
        if (type['id'] != 'all' && _allAlbums.containsKey(type['id'])) {
          combined.addAll((_allAlbums[type['id']] as List).cast<Map<String, dynamic>>());
        }
      }
      return combined;
    } else {
      return (_allAlbums[_selectedTypeId] as List?)?.cast<Map<String, dynamic>>() ?? [];
    }
  }

  void _showTypePicker(BuildContext context) {
    final List<PickerOption> options = _types.map((type) => PickerOption(
      id: type['id']!,
      name: type['name']!,
    )).toList();

    RefinedPicker.show(
      context,
      title: '专辑类型',
      options: options,
      selectedId: _selectedTypeId,
      onSelected: (opt) {
        setState(() {
          _selectedTypeId = opt.id;
          _selectedTypeName = opt.name;
        });
      },
      maxWidth: 360,
    );
  }

  @override
  Widget build(BuildContext context) {
    final albums = _getFilteredAlbums();

    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 40, vertical: 10),
          child: Row(
            children: [
              RefinedSelector(
                label: _selectedTypeName,
                onTap: () => _showTypePicker(context),
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
                                placeholder: (context, url) => Container(color: Theme.of(context).colorScheme.surfaceContainerHighest),
                                errorWidget: (context, url, error) => const Icon(CupertinoIcons.music_albums),
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
                            color: Theme.of(context).colorScheme.onSurface, 
                            fontSize: 13, 
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                        Text(
                          album['singername'] ?? '',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(color: Theme.of(context).colorScheme.onSurfaceVariant, fontSize: 11, fontWeight: FontWeight.w500),
                        ),
                      ],
                    ),
                  );
                },
              ),
        ),
      ],
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

    return FutureBuilder<List<Song>>(
      future: _songsFuture,
      builder: (context, snapshot) {
        if (!snapshot.hasData) return const Center(child: CupertinoActivityIndicator());
        final songs = snapshot.data!;

        return Stack(
          children: [
            Column(
              children: [
                if (songs.isNotEmpty && !selectionProvider.isSelectionMode)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(40, 10, 40, 0),
                    child: Row(
                      children: [
                        const Spacer(),
                        _buildBatchButton(context, selectionProvider, songs),
                      ],
                    ),
                  ),
                Expanded(
                  child: ListView.builder(
                    padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 20),
                    itemCount: songs.length,
                    itemBuilder: (context, index) {
                      final song = songs[index];
                      return Padding(
                        padding: EdgeInsets.only(
                          bottom: index == songs.length - 1 
                            ? (selectionProvider.isSelectionMode ? 80 : 20) 
                            : 0
                        ),
                        child: SongCard(
                          song: song,
                          playlist: songs,
                          showMore: true,
                          isSelectionMode: selectionProvider.isSelectionMode,
                          isSelected: selectionProvider.isSelected(song.hash),
                          onSelectionChanged: (selected) {
                            selectionProvider.toggleSelection(song.hash);
                          },
                        ),
                      );
                    },
                  ),
                ),
              ],
            ),
            const BatchActionBar(),
          ],
        );
      },
    );
  }

  Widget _buildBatchButton(BuildContext context, SelectionProvider selectionProvider, List<Song> songs) {
    final theme = Theme.of(context);
    
    return TextButton.icon(
      onPressed: () {
        selectionProvider.setSongList(songs);
        selectionProvider.enterSelectionMode();
      },
      icon: const Icon(CupertinoIcons.checkmark_circle, size: 16),
      label: const Text('批量选择', style: TextStyle(fontWeight: FontWeight.w800, fontSize: 13)),
      style: TextButton.styleFrom(
        foregroundColor: theme.colorScheme.onSurface,
        backgroundColor: theme.colorScheme.onSurface.withAlpha(20),
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
      ),
    );
  }
}
