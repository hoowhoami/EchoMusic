import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import '../../api/music_api.dart';
import '../../models/song.dart';
import '../../models/playlist.dart';
import 'package:echomusic/providers/refresh_provider.dart';
import 'package:echomusic/providers/navigation_provider.dart';
import '../widgets/custom_tab_bar.dart';
import '../widgets/custom_picker.dart';
import '../widgets/custom_selector.dart';
import '../widgets/back_to_top.dart';
import '../widgets/song_list_scaffold.dart';
import '../widgets/detail_page_sliver_header.dart';
import '../widgets/detail_page_action_row.dart';
import '../../providers/audio_provider.dart';
import '../widgets/custom_toast.dart';
import '../../providers/persistence_provider.dart';
import '../widgets/playlist_card.dart';
import '../widgets/album_card.dart';
import '../../models/album.dart';
import 'rank_view.dart';

class DiscoverView extends StatefulWidget {
  const DiscoverView({super.key});

  @override
  State<DiscoverView> createState() => _DiscoverViewState();
}

class _DiscoverViewState extends State<DiscoverView> with SingleTickerProviderStateMixin, RefreshableState {
  late TabController _tabController;

  @override
  String get refreshKey => 'root:1';

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 4, vsync: this);
  }

  @override
  void onRefresh() {
    setState(() {
      // Rebuild children
    });
  }

  @override
  void dispose() {
    _tabController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Scaffold(
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
              const SizedBox(height: 12),
              CustomTabBar(
                controller: _tabController,
                tabs: const ['歌单', '排行榜', '新碟上架', '新歌速递'],
              ),
            ],
          ),
        ),
      ),
      body: ScrollConfiguration(
        behavior: ScrollConfiguration.of(context).copyWith(scrollbars: false),
        child: TabBarView(
          controller: _tabController,
          physics: const BouncingScrollPhysics(),
          children: [
            const _DiscoverPlaylistTab(),
            const RankView(backgroundColor: Colors.transparent, showTitle: false),
            const _DiscoverAlbumTab(),
            const _DiscoverSongTab(),
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

class _DiscoverPlaylistTabState extends State<_DiscoverPlaylistTab> with RefreshableState {
  final ScrollController _scrollController = ScrollController();
  List<Playlist> _playlists = [];
  List<Map<String, dynamic>> _categories = [];
  String? _selectedCategoryId;
  String? _selectedCategoryName;
  bool _isLoading = true;

  @override
  String get refreshKey => 'root:1';

  @override
  void initState() {
    super.initState();
    _loadInitialData();
  }

  @override
  void dispose() {
    _scrollController.dispose();
    super.dispose();
  }

  @override
  void onRefresh() {
    if (_selectedCategoryId != null && _selectedCategoryName != null) {
      _loadPlaylists(_selectedCategoryId!, _selectedCategoryName!);
    } else {
      _loadInitialData();
    }
  }

  Future<void> _loadInitialData() async {
    final categories = await MusicApi.getPlaylistCategory();
    if (mounted) {
      setState(() {
        _categories = categories;
      });

      if (_categories.isNotEmpty) {
        final firstCat = _categories.first;
        final sons = (firstCat['son'] as List?)?.cast<Map<String, dynamic>>() ?? [];
        if (sons.isNotEmpty) {
          final firstSon = sons.first;
          final categoryId = firstSon['tag_id'].toString();
          final categoryName = '${firstCat['tag_name']} - ${firstSon['tag_name']}';
          _loadPlaylists(categoryId, categoryName);
        }
      }
    }
  }

  Future<void> _loadPlaylists(String categoryId, String categoryName) async {
    setState(() {
      _isLoading = true;
      _selectedCategoryId = categoryId;
      _selectedCategoryName = categoryName;
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
          name: son['tag_name'], // Just display the sub-category name inside the picker
          group: cat['tag_name'],
        ));
      }
    }

    CustomPicker.show(
      context,
      title: '歌单分类',
      options: options,
      selectedId: _selectedCategoryId ?? '',
      onSelected: (opt) {
        // Construct the full "Group - Tag" name for the external label
        final fullName = opt.group != null ? '${opt.group} - ${opt.name}' : opt.name;
        _loadPlaylists(opt.id, fullName);
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
              if (_selectedCategoryName != null)
                CustomSelector(
                  label: _selectedCategoryName!,
                  onTap: () => _showCategoryPicker(context),
                ),
            ],
          ),
        ),
        Expanded(
          child: _isLoading
            ? const Center(child: CupertinoActivityIndicator())
            : Stack(
                children: [
                  GridView.builder(
                    controller: _scrollController,
                    padding: const EdgeInsets.symmetric(horizontal: 40, vertical: 10),
                    gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
                      maxCrossAxisExtent: 220,
                      mainAxisExtent: 230,
                      mainAxisSpacing: 20,
                      crossAxisSpacing: 20,
                    ),
                    itemCount: _playlists.length,
                    itemBuilder: (context, index) {
                      final playlist = _playlists[index];
                      return PlaylistCard.grid(
                        playlist: playlist,
                        onTap: () =>
                            context.read<NavigationProvider>().openPlaylist(playlist),
                      );
                    },
                  ),
                  BackToTop(controller: _scrollController),
                ],
              ),
        ),
      ],
    );
  }
}

// Playlist card now lives in playlist_card.dart

class _DiscoverAlbumTab extends StatefulWidget {
  const _DiscoverAlbumTab();

  @override
  State<_DiscoverAlbumTab> createState() => _DiscoverAlbumTabState();
}

class _DiscoverAlbumTabState extends State<_DiscoverAlbumTab> with RefreshableState {
  final ScrollController _scrollController = ScrollController();
  String _selectedTypeId = 'all';
  String _selectedTypeName = '全部';
  Map<String, dynamic> _allAlbums = {};
  bool _isLoading = true;

  @override
  String get refreshKey => 'root:1';

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

  @override
  void dispose() {
    _scrollController.dispose();
    super.dispose();
  }

  @override
  void onRefresh() {
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

  List<Album> _getFilteredAlbums() {
    List<Map<String, dynamic>> rawAlbums = [];
    if (_selectedTypeId == 'all') {
      for (var type in _types) {
        if (type['id'] != 'all' && _allAlbums.containsKey(type['id'])) {
          rawAlbums.addAll((_allAlbums[type['id']] as List).cast<Map<String, dynamic>>());
        }
      }
    } else {
      rawAlbums = (_allAlbums[_selectedTypeId] as List?)?.cast<Map<String, dynamic>>() ?? [];
    }
    return rawAlbums.map((json) => Album.fromJson(json)).toList();
  }

  void _showTypePicker(BuildContext context) {
    final List<PickerOption> options = _types.map((type) => PickerOption(
      id: type['id']!,
      name: type['name']!,
    )).toList();

    CustomPicker.show(
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
              CustomSelector(
                label: _selectedTypeName,
                onTap: () => _showTypePicker(context),
              ),
            ],
          ),
        ),
        Expanded(
          child: _isLoading
            ? const Center(child: CupertinoActivityIndicator())
            : Stack(
                children: [
                  GridView.builder(
                    controller: _scrollController,
                    padding: const EdgeInsets.symmetric(horizontal: 40, vertical: 10),
                    gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
                      maxCrossAxisExtent: 220,
                      mainAxisExtent: 230,
                      mainAxisSpacing: 20,
                      crossAxisSpacing: 20,
                    ),
                    itemCount: albums.length,
                    itemBuilder: (context, index) {
                      final album = albums[index];
                      return AlbumCard.grid(
                        album: album,
                        subtitle: album.singerName,
                        onTap: () => context
                            .read<NavigationProvider>()
                            .openAlbum(album.id, album.name),
                      );
                    },
                  ),
                  BackToTop(controller: _scrollController),
                ],
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

class _DiscoverSongTabState extends State<_DiscoverSongTab>
    with RefreshableState {
  late Future<List<Song>> _songsFuture;

  @override
  String get refreshKey => 'root:1';

  @override
  void initState() {
    super.initState();
    _songsFuture = MusicApi.getNewSongs();
  }

  @override
  void dispose() {
    super.dispose();
  }

  void _playNewSongs(List<Song> songs) {
    if (songs.isEmpty) return;
    final firstPlayableIndex = songs.indexWhere((song) => song.isPlayable);
    if (firstPlayableIndex == -1) {
      CustomToast.error(context, '当前暂无可播放歌曲');
      return;
    }
    unawaited(_replacePlaybackWithNewSongs(songs[firstPlayableIndex], songs));
  }

  Future<void> _replacePlaybackWithNewSongs(
    Song song,
    List<Song> songs,
  ) async {
    if (songs.isEmpty) return;
    if (!songs.any((entry) => entry.isPlayable)) {
      CustomToast.error(context, '当前暂无可播放歌曲');
      return;
    }

    final audioProvider = context.read<AudioProvider>();
    unawaited(audioProvider.playSong(song, playlist: songs));
  }

  @override
  void onRefresh() {
    setState(() {
      _songsFuture = MusicApi.getNewSongs();
    });
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<List<Song>>(
      future: _songsFuture,
      builder: (context, snapshot) {
        if (!snapshot.hasData) {
          return const Center(child: CupertinoActivityIndicator());
        }
        final songs = snapshot.data!;
        final replacePlaylistEnabled =
            context.select<PersistenceProvider, bool>(
          (provider) => provider.settings['replacePlaylist'] ?? false,
        );
        final theme = Theme.of(context);

        return SongListScaffold(
          songs: songs,
          padding: const EdgeInsets.symmetric(horizontal: 40, vertical: 8),
          rowHorizontalPadding: 6,
          hasCommentsTab: false,
          enableDefaultDoubleTapPlay: true,
          onSongDoubleTapPlay: replacePlaylistEnabled
              ? (song) async {
                  await _replacePlaybackWithNewSongs(song, songs);
                }
              : null,
          headers: [
            DetailPageSliverHeader(
              typeLabel: 'NEW SONGS',
              title: '新歌速递',
              expandedHeight: kToolbarHeight,
              expandedPadding: const EdgeInsets.fromLTRB(40, 0, 40, 10),
              collapsedPadding: const EdgeInsets.fromLTRB(40, 0, 40, 0),
              expandedCover: _buildCollapsedCover(theme),
              collapsedCover: _buildCollapsedCover(theme),
              detailChildren: const <Widget>[],
              actions: DetailPageActionRow(
                playLabel: '播放',
                onPlay: () => _playNewSongs(songs),
                songs: songs,
              ),
            ),
          ],
        );
      },
    );
  }

  Widget _buildExpandedCover(ThemeData theme) {
    return Container(
      width: 136,
      height: 136,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(24),
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [
            theme.colorScheme.primary.withAlpha(220),
            theme.colorScheme.tertiary.withAlpha(180),
          ],
        ),
      ),
      child: Icon(
        CupertinoIcons.sparkles,
        size: 56,
        color: theme.colorScheme.onPrimary,
      ),
    );
  }

  Widget _buildCollapsedCover(ThemeData theme) {
    return Container(
      width: 32,
      height: 32,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(8),
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [
            theme.colorScheme.primary.withAlpha(200),
            theme.colorScheme.tertiary.withAlpha(160),
          ],
        ),
      ),
      child: Icon(
        CupertinoIcons.sparkles,
        size: 16,
        color: theme.colorScheme.onPrimary,
      ),
    );
  }
}
