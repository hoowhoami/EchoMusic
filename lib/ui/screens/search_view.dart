import 'package:flutter/material.dart';
import '../../api/music_api.dart';
import '../../models/song.dart';
import 'package:provider/provider.dart';
import '../../providers/audio_provider.dart';

class SearchView extends StatefulWidget {
  const SearchView({super.key});

  @override
  State<SearchView> createState() => _SearchViewState();
}

class _SearchViewState extends State<SearchView> {
  final TextEditingController _searchController = TextEditingController();
  List<Song> _searchResults = [];
  bool _isLoading = false;

  void _onSearch() async {
    final keywords = _searchController.text.trim();
    if (keywords.isEmpty) return;

    setState(() {
      _isLoading = true;
    });

    final results = await MusicApi.search(keywords);

    setState(() {
      _searchResults = results;
      _isLoading = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(20.0),
      child: Column(
        children: [
          TextField(
            controller: _searchController,
            decoration: InputDecoration(
              hintText: '搜索音乐、歌手、专辑',
              prefixIcon: const Icon(Icons.search),
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(30),
              ),
              suffixIcon: IconButton(
                icon: const Icon(Icons.send),
                onPressed: _onSearch,
              ),
            ),
            onSubmitted: (_) => _onSearch(),
          ),
          const SizedBox(height: 20),
          Expanded(
            child: _isLoading
                ? const Center(child: CircularProgressIndicator())
                : ListView.builder(
                    itemCount: _searchResults.length,
                    itemBuilder: (context, index) {
                      final song = _searchResults[index];
                      return ListTile(
                        leading: ClipRRect(
                          borderRadius: BorderRadius.circular(4),
                          child: Image.network(
                            song.cover,
                            width: 50,
                            height: 50,
                            fit: BoxFit.cover,
                            errorBuilder: (_, __, ___) => const Icon(Icons.music_note),
                          ),
                        ),
                        title: Text(song.name),
                        subtitle: Text(song.singerName),
                        onTap: () {
                          context.read<AudioProvider>().playSong(song, playlist: _searchResults);
                        },
                      );
                    },
                  ),
          ),
        ],
      ),
    );
  }
}
