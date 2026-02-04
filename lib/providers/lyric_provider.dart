import 'package:flutter/material.dart';

class LyricLine {
  final String text;
  final Duration startTime;

  LyricLine({required this.text, required this.startTime});
}

class LyricProvider with ChangeNotifier {
  List<LyricLine> _lyrics = [];
  int _currentLineIndex = -1;

  List<LyricLine> get lyrics => _lyrics;
  int get currentLineIndex => _currentLineIndex;

  void parseLyrics(String lrcContent) {
    _lyrics = [];
    final lines = lrcContent.split('\n');
    final regExp = RegExp(r'\[(\d+):(\d+\.\d+)\](.*)');

    for (var line in lines) {
      final match = regExp.firstMatch(line);
      if (match != null) {
        final minutes = int.parse(match.group(1)!);
        final seconds = double.parse(match.group(2)!);
        final text = match.group(3)!.trim();
        
        final startTime = Duration(
          milliseconds: (minutes * 60 * 1000 + seconds * 1000).toInt(),
        );
        
        _lyrics.add(LyricLine(text: text, startTime: startTime));
      }
    }
    
    _lyrics.sort((a, b) => a.startTime.compareTo(b.startTime));
    notifyListeners();
  }

  void updateHighlight(Duration position) {
    int newIndex = -1;
    for (int i = 0; i < _lyrics.length; i++) {
      if (position >= _lyrics[i].startTime) {
        newIndex = i;
      } else {
        break;
      }
    }
    
    if (newIndex != _currentLineIndex) {
      _currentLineIndex = newIndex;
      notifyListeners();
    }
  }

  void clear() {
    _lyrics = [];
    _currentLineIndex = -1;
    notifyListeners();
  }
}