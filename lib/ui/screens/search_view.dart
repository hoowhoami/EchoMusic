import 'dart:async';
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
import '../../models/album.dart';
import '../../models/artist.dart';
import '../widgets/song_card.dart';
import '../widgets/batch_action_bar.dart';
import '../widgets/custom_tab_bar.dart';

class SearchView extends StatefulWidget {
  const SearchView({super.key});

  @override
  State<SearchView> createState() => _SearchViewState();
}

class _SearchViewState extends State<SearchView> with SingleTickerProviderStateMixin {
  final TextEditingController _searchController = TextEditingController();
  final FocusNode _focusNode = FocusNode();
  late TabController _tabController;

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
  
  Timer? _debounce;

  @override
  void initState() {
    super.initState();
    _tabController = TabController(length: 4, vsync: this);
    _loadHotSearches();
    _focusNode.addListener(_onFocusChange);
  }

  @override
  void dispose() {
    _tabController.dispose();
    _searchController.dispose();
    _focusNode.removeListener(_onFocusChange);
    _focusNode.dispose();
    _debounce?.cancel();
    super.dispose();
  }

  void _onFocusChange() {
    if (_focusNode.hasFocus && _searchController.text.isNotEmpty && _suggestions.isNotEmpty) {
      setState(() => _showSuggestions = true);
    }
    // 注意：不再在失去焦点时立即隐藏，以防止干扰点击事件
  }

  Future<void> _loadHotSearches() async {
    setState(() {
      _isLoadingHot = true;
    });

    try {
      final hotCategories = await MusicApi.getSearchHotCategorized();
      final defaultKeyword = await MusicApi.getSearchDefault();
      setState(() {
        _hotSearchCategories = hotCategories;
        _defaultKeyword = defaultKeyword;
        _isLoadingHot = false;
      });
    } catch (e) {
      setState(() {
        _isLoadingHot = false;
      });
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
      } catch (e) {
        // ignore
      }
    });

    if (_hasSearched && value.isNotEmpty) {
      setState(() {
        _hasSearched = false;
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

    // 关键修复：立即加锁并同步 UI
    _isIgnoringChanges = true;
    if (keyword != null) {
      _searchController.text = keyword;
      _searchController.selection = TextSelection.fromPosition(
        TextPosition(offset: _searchController.text.length),
      );
    }

    // 立即隐藏建议和收起键盘
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
      
      // 延迟解锁，确保 UI 重建完成
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

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final selectionProvider = context.watch<SelectionProvider>();

    return Stack(
      children: [
        Padding(
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
                      _tabController.index == 0 && 
                      _hasSearched)
                    InkWell(
                      onTap: () {
                        selectionProvider.setSongList(_songResults);
                        selectionProvider.enterSelectionMode();
                      },
                      borderRadius: BorderRadius.circular(10),
                      child: Container(
                        height: 36,
                        padding: const EdgeInsets.symmetric(horizontal: 12),
                        decoration: BoxDecoration(
                          color: theme.colorScheme.onSurface.withAlpha(15),
                          borderRadius: BorderRadius.circular(10),
                        ),
                        child: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(
                              CupertinoIcons.checkmark_circle,
                              size: 16,
                              color: theme.colorScheme.onSurface.withAlpha(200),
                            ),
                            const SizedBox(width: 6),
                            Text(
                              '批量操作',
                              style: TextStyle(
                                fontSize: 12,
                                fontWeight: FontWeight.w700,
                                color: theme.colorScheme.onSurface.withAlpha(200),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
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
              Expanded(
                child: Stack(
                  children: [
                    if (!_hasSearched) 
                      _buildHotSearches()
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
                      Positioned.fill(
                        child: _buildSuggestions(theme),
                      ),
                  ],
                ),
              ),
            ],
          ),
        ),
        const BatchActionBar(),
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
                    onTap: () => _onSearch(text), // 触发搜索
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

    if (_hotSearchCategories.isEmpty) {
      return const SizedBox.shrink();
    }

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
                  showCheckmark: false, // 去掉打勾
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

    final selectionProvider = context.watch<SelectionProvider>();

    return ListView.builder(
      physics: const BouncingScrollPhysics(),
      itemCount: _songResults.length,
      padding: EdgeInsets.only(bottom: selectionProvider.isSelectionMode ? 80 : 20),
      itemBuilder: (context, index) {
        final song = _songResults[index];
        return SongCard(
          song: song,
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
        final playlist = _playlistResults[index];

        return ListTile(
          contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 2),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          leading: CoverImage(
            url: playlist.pic,
            width: 52,
            height: 52,
            borderRadius: 8,
            showShadow: false,
            size: 200,
          ),
          title: Text(
            playlist.name, 
            style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
          subtitle: Text(
            '${playlist.count} 首歌曲 • ${playlist.nickname.isNotEmpty ? playlist.nickname : "未知作者"} • ${_formatPlayCount(playlist.playCount)} 次播放', 
            style: Theme.of(context).textTheme.bodyMedium?.copyWith(fontSize: 12, fontWeight: FontWeight.w500),
          ),
          onTap: () {
            Navigator.push(context, CupertinoPageRoute(builder: (_) => PlaylistDetailView(playlist: playlist)));
          },
        );
      },
    );
  }

  String _formatPlayCount(int count) {
    if (count < 10000) return count.toString();
    return '${(count / 10000).toStringAsFixed(1)}万';
  }

  Widget _buildAlbumList() {
    if (_albumResults.isEmpty) return _buildEmptyState();
    return ListView.builder(
      physics: const BouncingScrollPhysics(),
      itemCount: _albumResults.length,
      padding: EdgeInsets.zero,
      itemBuilder: (context, index) {
        final album = _albumResults[index];
        
        return ListTile(
          contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 2),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          leading: CoverImage(
            url: album.pic,
            width: 52,
            height: 52,
            borderRadius: 8,
            showShadow: false,
            size: 200,
          ),
          title: Text(
            album.name, 
            style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
          subtitle: Text(
            '${album.singerName} • ${album.publishTime} • ${album.songCount} 首歌曲', 
            style: Theme.of(context).textTheme.bodyMedium?.copyWith(fontSize: 12, fontWeight: FontWeight.w500),
          ),
          onTap: () {
            Navigator.push(
              context,
              CupertinoPageRoute(
                builder: (_) => AlbumDetailView(
                  albumId: album.id,
                  albumName: album.name,
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
        
        return ListTile(
          contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 2),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
          leading: Container(
            width: 52,
            height: 52,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              border: Border.all(color: theme.dividerColor, width: 0.5),
            ),
            child: ClipOval(
              child: CoverImage(
                url: artist.pic,
                width: 52,
                height: 52,
                borderRadius: 0,
                showShadow: false,
                size: 200,
              ),
            ),
          ),
          title: Text(
            artist.name, 
            style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700),
          ),
          subtitle: Text(
            '${artist.songCount} 首歌曲 • ${artist.albumCount} 张专辑 • ${_formatPlayCount(artist.fansCount)} 粉丝',
            style: theme.textTheme.bodyMedium?.copyWith(fontSize: 12, fontWeight: FontWeight.w500),
          ),
          onTap: () {
            Navigator.push(
              context,
              CupertinoPageRoute(
                builder: (_) => ArtistDetailView(
                  artistId: artist.id,
                  artistName: artist.name,
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
}
