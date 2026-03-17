import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import '../../api/music_api.dart';
import '../../models/song.dart';
import '../../providers/navigation_provider.dart';
import '../../models/playlist.dart';
import '../../models/album.dart';
import '../../models/artist.dart';
import '../widgets/song_list_scaffold.dart';
import '../widgets/detail_page_sliver_header.dart';
import '../widgets/detail_page_action_row.dart';
import '../widgets/custom_toast.dart';
import '../../providers/audio_provider.dart';
import '../../providers/persistence_provider.dart';
import '../widgets/custom_tab_bar.dart';
import '../widgets/back_to_top.dart';
import '../widgets/playlist_card.dart';
import '../widgets/album_card.dart';
import '../widgets/artist_card.dart';

class SearchView extends StatefulWidget {
  const SearchView({super.key});

  @override
  State<SearchView> createState() => _SearchViewState();
}

class _SearchViewState extends State<SearchView> with SingleTickerProviderStateMixin {
  static const double _pinnedSearchBarPadding = 4.0;
  static const double _pinnedSearchBarHeight =
      42.0 + _pinnedSearchBarPadding * 2;

  final TextEditingController _searchController = TextEditingController();
  final FocusNode _focusNode = FocusNode();
  late TabController _tabController;

  final ScrollController _playlistScrollController = ScrollController();
  final ScrollController _albumScrollController = ScrollController();
  final ScrollController _artistScrollController = ScrollController();

  List<Song> _songResults = [];
  List<Album> _albumResults = [];
  List<Artist> _artistResults = [];
  List<Playlist> _playlistResults = [];

  List<Map<String, dynamic>> _hotSearchCategories = [];
  int _selectedHotCategoryIndex = 0;
  List<Map<String, dynamic>> _suggestions = [];
  String _defaultKeyword = '';
  bool _isLoading = false;
  bool _isLoadingHot = true;
  bool _hasSearched = false;
  bool _showSuggestions = false;
  bool _isIgnoringChanges = false;
  bool _showPinnedSearch = false;
  
  // 用于手动控制回到顶部按钮的显隐
  bool _showBackToTop = false;

  Timer? _debounce;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 4, vsync: this);
    _tabController.addListener(_handleTabChange);
    _loadHotSearches();
    _focusNode.addListener(_onFocusChange);
  }

  // 切换 Tab 时根据对应列表的滚动位置更新按钮状态
  void _handleTabChange() {
    if (_tabController.indexIsChanging) return;
    _updateBackToTopVisibility();
    if (!_showPinnedSearch) {
      _updatePinnedSearchVisibility();
    }
  }

  void _updateBackToTopVisibility() {
    if (_tabController.index == 0) {
      if (_showBackToTop) {
        setState(() => _showBackToTop = false);
      }
      return;
    }

    ScrollController currentController;
    switch (_tabController.index) {
      case 1: currentController = _playlistScrollController; break;
      case 2: currentController = _albumScrollController; break;
      case 3: currentController = _artistScrollController; break;
      default: return;
    }

    final bool shouldShow =
        currentController.hasClients && currentController.offset > 300;
    if (_showBackToTop != shouldShow) {
      setState(() => _showBackToTop = shouldShow);
    }
  }

  void _updatePinnedSearchVisibility({ScrollMetrics? metrics}) {
    if (!_hasSearched) {
      if (_showPinnedSearch) {
        setState(() => _showPinnedSearch = false);
      }
      return;
    }

    double? currentOffset = metrics?.pixels;
    if (currentOffset == null) {
      if (_tabController.index == 0) {
        if (_showPinnedSearch) {
          setState(() => _showPinnedSearch = false);
        }
        return;
      }

      ScrollController currentController;
      switch (_tabController.index) {
        case 1:
          currentController = _playlistScrollController;
          break;
        case 2:
          currentController = _albumScrollController;
          break;
        case 3:
          currentController = _artistScrollController;
          break;
        default:
          return;
      }

      currentOffset =
          currentController.hasClients ? currentController.offset : 0.0;
    }

    final shouldShow = currentOffset > 80;
    if (_showPinnedSearch != shouldShow) {
      setState(() => _showPinnedSearch = shouldShow);
    }
  }

  @override
  void dispose() {
    _tabController.removeListener(_handleTabChange);
    _tabController.dispose();
    _searchController.dispose();
    _focusNode.removeListener(_onFocusChange);
    _focusNode.dispose();
    _debounce?.cancel();
    _playlistScrollController.dispose();
    _albumScrollController.dispose();
    _artistScrollController.dispose();
    super.dispose();
  }

  void _onFocusChange() {
    if (_focusNode.hasFocus && _searchController.text.isNotEmpty && _suggestions.isNotEmpty) {
      setState(() => _showSuggestions = true);
    }
  }

  Future<void> _loadHotSearches() async {
    setState(() => _isLoadingHot = true);
    try {
      final hotCategories = await MusicApi.getSearchHotCategorized();
      final defaultKeyword = await MusicApi.getSearchDefault();
      setState(() {
        _hotSearchCategories = hotCategories;
        _defaultKeyword = defaultKeyword;
        _isLoadingHot = false;
      });
    } catch (e) {
      setState(() => _isLoadingHot = false);
    }
  }

  void _onSearchChanged(String value) {
    if (_isIgnoringChanges) return;
    if (_debounce?.isActive ?? false) _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 300), () async {
      if (value.isEmpty) {
        setState(() {
          _suggestions = [];
          _showSuggestions = false;
        });
        return;
      }
      try {
        final suggestions = await MusicApi.getSearchSuggest(value);
        if (!mounted || _isIgnoringChanges) return;
        setState(() {
          _suggestions = suggestions;
          _showSuggestions = _focusNode.hasFocus && _suggestions.isNotEmpty;
        });
      } catch (_) {
        // Ignore suggestion fetch failures and keep the current UI state.
      }
    });

    if (_hasSearched && value.isNotEmpty) {
      setState(() {
        _hasSearched = false;
        _showPinnedSearch = false;
      });
    }
    setState(() {
      _showSuggestions = _focusNode.hasFocus && value.isNotEmpty && _suggestions.isNotEmpty;
    });
  }

  void _onSearch([String? keyword]) async {
    final keywords = keyword ?? _searchController.text.trim();
    if (keywords.isEmpty && _defaultKeyword.isNotEmpty) {
      _onSearch(_defaultKeyword);
      return;
    }
    if (keywords.isEmpty) return;

    _isIgnoringChanges = true;
    if (keyword != null) {
      _searchController.text = keyword;
      _searchController.selection = TextSelection.fromPosition(
        TextPosition(offset: _searchController.text.length),
      );
    }

    setState(() {
      _showSuggestions = false;
      _isLoading = true;
      _hasSearched = true;
    });
    _focusNode.unfocus();

    try {
      final results = await Future.wait([
        MusicApi.search(keywords, type: 'song'),
        MusicApi.getSearchResult(keywords, type: 'album'),
        MusicApi.getSearchResult(keywords, type: 'author'),
        MusicApi.getSearchResult(keywords, type: 'special'),
      ]);

      if (!mounted) return;

      final songRes = results[0] as List<Song>;
      final albumRes = results[1] as Map<String, dynamic>;
      final artistRes = results[2] as Map<String, dynamic>;
      final playlistRes = results[3] as Map<String, dynamic>;

      setState(() {
        _songResults = songRes;
        _albumResults = (albumRes['data']?['lists'] as List?)?.map((json) => Album.fromSearchJson(json)).toList().cast<Album>() ?? [];
        _artistResults = (artistRes['data']?['lists'] as List?)?.map((json) => Artist.fromSearchJson(json)).toList().cast<Artist>() ?? [];
        _playlistResults = (playlistRes['data']?['lists'] as List?)?.map((json) => Playlist.fromSearchJson(json)).toList().cast<Playlist>() ?? [];
        _isLoading = false;
      });
      
      Future.delayed(const Duration(milliseconds: 100), () {
        if (mounted) _isIgnoringChanges = false;
      });
    } catch (e) {
      if (mounted) {
        setState(() {
          _isLoading = false;
          _isIgnoringChanges = false;
        });
      }
    }
  }

  void _scrollToTop() {
    if (_tabController.index == 0) return;

    ScrollController currentController;
    switch (_tabController.index) {
      case 1: currentController = _playlistScrollController; break;
      case 2: currentController = _albumScrollController; break;
      case 3: currentController = _artistScrollController; break;
      default: return;
    }
    
    currentController.animateTo(
      0,
      duration: const Duration(milliseconds: 500),
      curve: Curves.easeInOutCubic,
    );
  }

  Widget _buildSearchHeader(ThemeData theme) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Text(
              '搜索',
              style: theme.textTheme.titleLarge?.copyWith(
                fontSize: 22,
                letterSpacing: -0.5,
              ),
            ),
            const Spacer(),
          ],
        ),
        const SizedBox(height: 24),
        _buildSearchInput(theme),
        const SizedBox(height: 24),
        if (_hasSearched) ...[
          CustomTabBar(
            controller: _tabController,
            tabs: const ['单曲', '歌单', '专辑', '歌手'],
            onTap: (_) => setState(() {}),
          ),
          const SizedBox(height: 16),
        ],
      ],
    );
  }

  Widget _buildPinnedSearchBar(ThemeData theme) {
    if (!_hasSearched) return const SizedBox.shrink();
    return Container(
      height: _pinnedSearchBarHeight,
      padding: EdgeInsets.fromLTRB(
        40,
        _pinnedSearchBarPadding,
        40,
        _pinnedSearchBarPadding,
      ),
      decoration: BoxDecoration(
        color: theme.scaffoldBackgroundColor,
        border: Border(
          bottom: BorderSide(
            color: theme.dividerColor.withAlpha(30),
            width: 0.5,
          ),
        ),
      ),
      child: Center(
        child: CustomTabBar(
          controller: _tabController,
          tabs: const ['单曲', '歌单', '专辑', '歌手'],
          onTap: (_) => setState(() {}),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Stack(
      children: [
        NotificationListener<ScrollNotification>(
          onNotification: (notification) {
            if (notification.metrics.axis == Axis.vertical) {
              _updateBackToTopVisibility();
              _updatePinnedSearchVisibility(metrics: notification.metrics);
            }
            return false;
          },
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: EdgeInsets.only(
                  top: _showPinnedSearch ? 0 : 32,
                ),
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 40),
                  child: AnimatedSize(
                    duration: const Duration(milliseconds: 180),
                    curve: Curves.easeOutCubic,
                    child: _showPinnedSearch
                        ? const SizedBox.shrink()
                        : _buildSearchHeader(theme),
                  ),
                ),
              ),
              Expanded(
                child: Stack(
                  children: [
                    if (!_hasSearched) 
                      Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 40),
                        child: _buildHotSearches(),
                      )
                    else if (_isLoading)
                      const Center(child: CupertinoActivityIndicator())
                    else
                      TabBarView(
                        controller: _tabController,
                        physics: const BouncingScrollPhysics(),
                        children: [
                          _buildSongList(),
                          _buildPlaylistList(),
                          _buildAlbumList(),
                          _buildArtistList(),
                        ],
                      ),
                    if (_showSuggestions) 
                      Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 40),
                        child: _buildSuggestions(theme),
                      ),
                  ],
                ),
              ),
            ],
          ),
        ),
        if (_showPinnedSearch)
          Positioned(
            top: 0,
            left: 0,
            right: 0,
            child: _buildPinnedSearchBar(theme),
          ),
        BackToTop(
          show: _showBackToTop,
          onPressed: _scrollToTop,
        ),
      ],
    );
  }

  Widget _buildSearchInput(ThemeData theme) {
    return Container(
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
              focusNode: _focusNode,
              textAlignVertical: const TextAlignVertical(y: -0.6),
              style: const TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w500,
              ),
              decoration: InputDecoration(
                hintText: _defaultKeyword.isNotEmpty ? '搜索: $_defaultKeyword' : '搜索音乐、歌手、专辑',
                hintStyle: TextStyle(color: theme.colorScheme.onSurface.withAlpha(80)),
                border: InputBorder.none,
                isCollapsed: true,
                contentPadding: const EdgeInsets.symmetric(vertical: 10),
              ),
              onChanged: _onSearchChanged,
              onSubmitted: (_) => _onSearch(),
            ),
          ),
          if (_searchController.text.isNotEmpty)
            IconButton(
              icon: const Icon(CupertinoIcons.clear_thick_circled, size: 16),
              onPressed: () {
                _searchController.clear();
                _onSearchChanged('');
              },
              color: theme.colorScheme.onSurface.withAlpha(60),
              padding: EdgeInsets.zero,
              constraints: const BoxConstraints(),
            ),
          const SizedBox(width: 8),
          Padding(
            padding: const EdgeInsets.all(4.0),
            child: ElevatedButton(
              onPressed: () => _onSearch(),
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
    );
  }

  Widget _buildSuggestions(ThemeData theme) {
    if (_suggestions.isEmpty) return const SizedBox.shrink();

    return GestureDetector(
      onTap: () => setState(() => _showSuggestions = false),
      behavior: HitTestBehavior.translucent,
      child: Container(
        decoration: BoxDecoration(
          color: theme.colorScheme.surface,
          borderRadius: BorderRadius.circular(12),
        ),
        child: ListView.builder(
          padding: const EdgeInsets.symmetric(vertical: 8),
          itemCount: _suggestions.length,
          itemBuilder: (context, index) {
            final category = _suggestions[index];
            final label = category['LableName']?.toString() ?? '';
            final records = (category['RecordDatas'] as List?)?.cast<Map<String, dynamic>>() ?? [];

            if (records.isEmpty || label == 'MV') return const SizedBox.shrink();

            return Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (label.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
                    child: Text(
                      label,
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w700,
                        color: theme.colorScheme.primary,
                      ),
                    ),
                  ),
                ...records.map((record) {
                  final text = record['HintInfo']?.toString() ?? '';
                  return ListTile(
                    dense: true,
                    leading: Icon(CupertinoIcons.search, size: 14, color: theme.colorScheme.onSurface.withAlpha(100)),
                    title: Text(
                      text,
                      style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w500),
                    ),
                    onTap: () => _onSearch(text), 
                  );
                }),
              ],
            );
          },
        ),
      ),
    );
  }

  Widget _buildHotSearches() {
    if (_isLoadingHot) {
      return const Center(child: CupertinoActivityIndicator());
    }
    if (_hotSearchCategories.isEmpty) return const SizedBox.shrink();

    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SingleChildScrollView(
          scrollDirection: Axis.horizontal,
          physics: const BouncingScrollPhysics(),
          child: Row(
            children: _hotSearchCategories.asMap().entries.map((entry) {
              final idx = entry.key;
              final category = entry.value;
              final name = category['name']?.toString() ?? '';
              final isSelected = _selectedHotCategoryIndex == idx;

              return Padding(
                padding: const EdgeInsets.only(right: 12),
                child: ChoiceChip(
                  label: Text(name),
                  selected: isSelected,
                  showCheckmark: false,
                  onSelected: (selected) {
                    if (selected) {
                      setState(() => _selectedHotCategoryIndex = idx);
                    }
                  },
                  labelStyle: TextStyle(
                    fontSize: 13,
                    fontWeight: isSelected ? FontWeight.w700 : FontWeight.w500,
                    color: isSelected ? theme.colorScheme.onPrimary : theme.colorScheme.onSurface,
                  ),
                  selectedColor: theme.colorScheme.primary,
                  backgroundColor: theme.colorScheme.onSurface.withAlpha(10),
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
                  side: BorderSide.none,
                  padding: const EdgeInsets.symmetric(horizontal: 4),
                ),
              );
            }).toList(),
          ),
        ),
        const SizedBox(height: 24),
        Expanded(
          child: ListView(
            physics: const BouncingScrollPhysics(),
            children: [
              Wrap(
                spacing: 12,
                runSpacing: 12,
                children: (_hotSearchCategories[_selectedHotCategoryIndex]['keywords'] as List? ?? [])
                    .map((item) {
                  final keyword = item['keyword']?.toString() ?? '';
                  final reason = item['reason']?.toString() ?? '';
                  return GestureDetector(
                    onTap: () => _onSearch(keyword),
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
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            keyword,
                            style: TextStyle(
                              fontSize: 13,
                              fontWeight: FontWeight.w500,
                              color: theme.colorScheme.onSurface,
                            ),
                          ),
                          if (reason.isNotEmpty && reason != keyword) ...[
                            const SizedBox(width: 4),
                            Text(
                              '•',
                              style: TextStyle(color: theme.colorScheme.onSurface.withAlpha(50)),
                            ),
                            const SizedBox(width: 4),
                            Text(
                              reason,
                              style: TextStyle(
                                fontSize: 11,
                                color: theme.colorScheme.onSurface.withAlpha(100),
                              ),
                            ),
                          ],
                        ],
                      ),
                    ),
                  );
                }).toList(),
              ),
              const SizedBox(height: 40),
            ],
          ),
        ),
      ],
    );
  }

  Widget _buildSongList() {
    if (_songResults.isEmpty) return _buildEmptyState();
    final replacePlaylistEnabled =
        context.select<PersistenceProvider, bool>(
      (provider) => provider.settings['replacePlaylist'] ?? false,
    );
    final theme = Theme.of(context);

    return SongListScaffold(
      songs: _songResults,
      padding: const EdgeInsets.symmetric(horizontal: 40, vertical: 8),
      rowHorizontalPadding: 14,
      hasCommentsTab: false,
      enableDefaultDoubleTapPlay: true,
      onSongDoubleTapPlay: replacePlaylistEnabled
          ? (song) async {
              await _replacePlaybackWithSearchSongs(song, _songResults);
            }
          : null,
      headers: [
        DetailPageSliverHeader(
          typeLabel: 'SONGS',
          title: '热门单曲',
          expandedHeight: kToolbarHeight,
          expandedPadding: const EdgeInsets.fromLTRB(40, 0, 40, 10),
          collapsedPadding: const EdgeInsets.fromLTRB(40, 0, 40, 0),
          expandedCover: _buildSearchMiniCover(theme),
          collapsedCover: _buildSearchMiniCover(theme),
          detailChildren: const <Widget>[],
          actions: DetailPageActionRow(
            playLabel: '播放',
            onPlay: () => _playSearchSongs(_songResults),
            songs: _songResults,
          ),
        ),
      ],
    );
  }

  void _playSearchSongs(List<Song> songs) {
    if (songs.isEmpty) return;
    final firstPlayableIndex = songs.indexWhere((song) => song.isPlayable);
    if (firstPlayableIndex == -1) {
      CustomToast.error(context, '当前搜索结果暂无可播放歌曲');
      return;
    }
    unawaited(_replacePlaybackWithSearchSongs(songs[firstPlayableIndex], songs));
  }

  Future<void> _replacePlaybackWithSearchSongs(
    Song song,
    List<Song> songs,
  ) async {
    if (songs.isEmpty) return;
    if (!songs.any((entry) => entry.isPlayable)) {
      CustomToast.error(context, '当前搜索结果暂无可播放歌曲');
      return;
    }

    final audioProvider = context.read<AudioProvider>();
    unawaited(audioProvider.playSong(song, playlist: songs));
  }

  Widget _buildSearchCover(ThemeData theme) {
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
            theme.colorScheme.secondary.withAlpha(180),
          ],
        ),
      ),
      child: Icon(
        CupertinoIcons.search,
        size: 56,
        color: theme.colorScheme.onPrimary,
      ),
    );
  }

  Widget _buildSearchMiniCover(ThemeData theme) {
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
            theme.colorScheme.secondary.withAlpha(160),
          ],
        ),
      ),
      child: Icon(
        CupertinoIcons.search,
        size: 16,
        color: theme.colorScheme.onPrimary,
      ),
    );
  }

  Widget _buildPlaylistList() {
    if (_playlistResults.isEmpty) return _buildEmptyState();
    return Scrollbar(
      controller: _playlistScrollController,
      child: GridView.builder(
        controller: _playlistScrollController,
        physics: const BouncingScrollPhysics(),
        itemCount: _playlistResults.length,
        padding: const EdgeInsets.fromLTRB(40, 0, 40, 24),
        gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
          maxCrossAxisExtent: 220,
          mainAxisExtent: 230,
          mainAxisSpacing: 20,
          crossAxisSpacing: 20,
        ),
        itemBuilder: (context, index) {
          final playlist = _playlistResults[index];
          return PlaylistCard.grid(
            playlist: playlist,
            titleMaxLines: 1,
            onTap: () =>
                context.read<NavigationProvider>().openPlaylist(playlist),
          );
        },
      ),
    );
  }

  String _formatPlayCount(int count) {
    if (count < 10000) return count.toString();
    return '${(count / 10000).toStringAsFixed(1)}万';
  }

  Widget _buildAlbumList() {
    if (_albumResults.isEmpty) return _buildEmptyState();
    return Scrollbar(
      controller: _albumScrollController,
      child: GridView.builder(
        controller: _albumScrollController,
        physics: const BouncingScrollPhysics(),
        itemCount: _albumResults.length,
        padding: const EdgeInsets.fromLTRB(40, 0, 40, 24),
        gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
          maxCrossAxisExtent: 220,
          mainAxisExtent: 230,
          mainAxisSpacing: 20,
          crossAxisSpacing: 20,
        ),
        itemBuilder: (context, index) {
          final album = _albumResults[index];
          final subtitleParts = <String>[];
          if (album.singerName.isNotEmpty) {
            subtitleParts.add(album.singerName);
          }
          if (album.songCount > 0) {
            subtitleParts.add('${album.songCount} 首歌曲');
          }
          final subtitle =
              subtitleParts.isEmpty ? null : subtitleParts.join(' • ');
          return AlbumCard.grid(
            album: album,
            subtitle: subtitle,
            onTap: () => context
                .read<NavigationProvider>()
                .openAlbum(album.id, album.name),
          );
        },
      ),
    );
  }

  Widget _buildArtistList() {
    if (_artistResults.isEmpty) return _buildEmptyState();
    return Scrollbar(
      controller: _artistScrollController,
      child: GridView.builder(
        controller: _artistScrollController,
        physics: const BouncingScrollPhysics(),
        itemCount: _artistResults.length,
        padding: const EdgeInsets.fromLTRB(40, 0, 40, 24),
        gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
          maxCrossAxisExtent: 220,
          mainAxisExtent: 230,
          mainAxisSpacing: 20,
          crossAxisSpacing: 20,
        ),
        itemBuilder: (context, index) {
          final artist = _artistResults[index];
          return ArtistCard.grid(
            artist: artist,
            subtitle:
                '${artist.songCount} 首歌曲 • ${artist.albumCount} 张专辑',
            onTap: () => context
                .read<NavigationProvider>()
                .openArtist(artist.id, artist.name),
          );
        },
      ),
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
}
