import 'package:flutter/material.dart';
import '../models/song.dart';
import '../api/music_api.dart';

class SelectionProvider with ChangeNotifier {
  final Set<String> _selectedHashes = {};
  bool _isSelectionMode = false;
  List<Song> _currentSongList = [];
  dynamic _sourcePlaylistId;

  Set<String> get selectedHashes => _selectedHashes;
  List<Song> get selectedSongs {
    return _currentSongList.where((s) => s.hash.isNotEmpty && _selectedHashes.contains(s.hash)).toList();
  }
  List<Song> get currentSongList => _currentSongList;
  bool get isSelectionMode => _isSelectionMode;
  int get selectedCount => selectedSongs.length;
  bool get hasSelection => _selectedHashes.isNotEmpty;
  dynamic get sourcePlaylistId => _sourcePlaylistId;

  void setSongList(List<Song> songs, {dynamic playlistId}) {
    _currentSongList = songs;
    _sourcePlaylistId = playlistId;
  }

  void enterSelectionMode() {
    _isSelectionMode = true;
    _selectedHashes.clear();
    notifyListeners();
  }

  void exitSelectionMode() {
    _isSelectionMode = false;
    _selectedHashes.clear();
    notifyListeners();
  }

  void toggleSelection(String hash) {
    if (hash.isEmpty) return;

    if (_selectedHashes.contains(hash)) {
      _selectedHashes.remove(hash);
    } else {
      _selectedHashes.add(hash);
    }
    notifyListeners();
  }

  void selectAll() {
    _selectedHashes.clear();
    for (final song in _currentSongList) {
      if (song.hash.isNotEmpty) {
        _selectedHashes.add(song.hash);
      }
    }
    notifyListeners();
  }

  void clearSelection() {
    _selectedHashes.clear();
    notifyListeners();
  }

  void reset() {
    _isSelectionMode = false;
    _selectedHashes.clear();
    _currentSongList = [];
    _sourcePlaylistId = null;
    notifyListeners();
  }

  bool isSelected(String hash) {
    return hash.isNotEmpty && _selectedHashes.contains(hash);
  }

  // Batch operations
  Future<bool> addAllToPlaylist(int listId) async {
    final hashes = selectedSongs.map((song) => song.hash).where((hash) => hash.isNotEmpty).join(',');
    if (hashes.isEmpty) return false;

    final success = await MusicApi.addPlaylistTrack(listId, hashes);
    if (success) {
      exitSelectionMode();
    }
    return success;
  }

  Future<bool> deleteAllFromPlaylist(int listId) async {
    final fileids = selectedSongs
        .map((song) => song.fileId?.toString() ?? song.hash)
        .where((value) => value.isNotEmpty)
        .join(',');
    if (fileids.isEmpty) return false;

    final success = await MusicApi.deletePlaylistTrack(listId, fileids);
    if (success) {
      exitSelectionMode();
    }
    return success;
  }
}
