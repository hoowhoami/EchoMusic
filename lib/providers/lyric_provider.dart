import 'dart:convert';
import 'package:flutter/material.dart';

class LyricCharacter {
  final String text;
  final int startTime; // milliseconds
  final int endTime; // milliseconds
  bool highlighted = false;

  LyricCharacter({
    required this.text,
    required this.startTime,
    required this.endTime,
  });
}

class LyricLine {
  final List<LyricCharacter> characters;
  final String? translated;
  final String? romanized;

  LyricLine({
    required this.characters,
    this.translated,
    this.romanized,
  });

  String get text => characters.map((c) => c.text).join('');
  int get startTime => characters.first.startTime;
  int get endTime => characters.last.endTime;
}

class LyricProvider with ChangeNotifier {
  List<LyricLine> _lyrics = [];
  int _currentLineIndex = -1;
  String _tips = '暂无歌词';
  bool _showTranslation = true;

  List<LyricLine> get lyrics => _lyrics;
  int get currentLineIndex => _currentLineIndex;
  String get tips => _tips;
  bool get showTranslation => _showTranslation;

  void toggleTranslation() {
    _showTranslation = !_showTranslation;
    notifyListeners();
  }

  void parseLyrics(Map<String, dynamic> lyricData) {
    _lyrics = [];
    final String content = (lyricData['decodeContent'] ?? lyricData['lyric'] ?? '').toString();
    if (content.isEmpty) {
      _tips = '暂无歌词';
      notifyListeners();
      return;
    }

    final List<String> lines = content.split('\n');
    List<dynamic>? translationLyrics;
    List<dynamic>? romanizationLyrics;

    // Parse translation and romanization
    try {
      String languageLine = '';
      for (final String line in lines) {
        if (line.startsWith('[language:')) {
          languageLine = line;
          break;
        }
      }

      if (languageLine.isNotEmpty) {
        final languageCode = languageLine.substring(10, languageLine.length - 1);
        if (languageCode.isNotEmpty) {
          final cleanedCode = languageCode.replaceAll(RegExp(r'[^A-Za-z0-9+/=]'), '');
          final paddedCode = cleanedCode.padRight(
            cleanedCode.length + (4 - cleanedCode.length % 4) % 4,
            '=',
          );
          final decodedData = utf8.decode(base64.decode(paddedCode));
          final languageData = jsonDecode(decodedData);

          if (languageData['content'] != null) {
            for (var section in languageData['content']) {
              if (section['type'] == 1) {
                translationLyrics = section['lyricContent'] as List?;
              } else if (section['type'] == 0) {
                romanizationLyrics = section['lyricContent'] as List?;
              }
            }
          }
        }
      }
    } catch (e) {
      debugPrint('Error parsing lyric language data: $e');
    }

    final charRegex = RegExp(r'<(\d+),(\d+),\d+>([^<]+)');
    final parsedLines = <LyricLine>[];

    for (var line in lines) {
      // Match KRC line format: [start,duration]text
      final lineMatch = RegExp(r'^\[(\d+),(\d+)\](.*)').firstMatch(line);
      if (lineMatch != null) {
        final lineStart = int.parse(lineMatch.group(1)!);
        final lineContent = lineMatch.group(3)!;
        final characters = <LyricCharacter>[];

        final matches = charRegex.allMatches(lineContent);
        if (matches.isNotEmpty) {
          for (final match in matches) {
            final charText = match.group(3)!;
            final charDuration = int.parse(match.group(2)!);
            final charStart = lineStart + int.parse(match.group(1)!);

            characters.add(LyricCharacter(
              text: charText,
              startTime: charStart,
              endTime: charStart + charDuration,
            ));
          }
        } else {
          // Fallback for LRC-like lines within KRC or simple lines
          final duration = int.parse(lineMatch.group(2)!);
          final text = lineContent.replaceAll(RegExp(r'<.*?>'), '').trim();
          if (text.isNotEmpty) {
            // Distribute duration equally if no per-char timing
            for (int i = 0; i < text.length; i++) {
              characters.add(LyricCharacter(
                text: text[i],
                startTime: lineStart + (i * duration ~/ text.length),
                endTime: lineStart + ((i + 1) * duration ~/ text.length),
              ));
            }
          }
        }

        if (characters.isNotEmpty) {
          parsedLines.add(LyricLine(characters: characters));
        }
        continue;
      }

      // Match standard LRC format: [mm:ss.xx]text
      final lrcMatch = RegExp(r'^\[(\d+):(\d+\.\d+)\](.*)').firstMatch(line);
      if (lrcMatch != null) {
        final minutes = int.parse(lrcMatch.group(1)!);
        final seconds = double.parse(lrcMatch.group(2)!);
        final text = lrcMatch.group(3)!.trim();
        final startTime = (minutes * 60 * 1000 + seconds * 1000).toInt();

        if (text.isNotEmpty) {
          parsedLines.add(LyricLine(characters: [
            LyricCharacter(text: text, startTime: startTime, endTime: startTime + 3000)
          ]));
        }
      }
    }

    // Assign translations and romanizations
    for (int i = 0; i < parsedLines.length; i++) {
      String? trans;
      String? roman;
      
      if (translationLyrics != null && i < translationLyrics.length) {
        final transLine = translationLyrics[i];
        if (transLine is List && transLine.isNotEmpty) {
          trans = transLine[0].toString();
        }
      }
      
      if (romanizationLyrics != null && i < romanizationLyrics.length) {
        final romanLine = romanizationLyrics[i];
        if (romanLine is List) {
          roman = romanLine.join('');
        }
      }

      _lyrics.add(LyricLine(
        characters: parsedLines[i].characters,
        translated: trans,
        romanized: roman,
      ));
    }

    _tips = _lyrics.isEmpty ? '暂无歌词' : '歌词已加载';
    notifyListeners();
  }

  void updateHighlight(Duration position) {
    final posMs = position.inMilliseconds;
    int newIndex = -1;
    bool statusChanged = false;

    for (int i = 0; i < _lyrics.length; i++) {
      final line = _lyrics[i];
      bool isLineActive = false;

      for (var char in line.characters) {
        final shouldBeHighlighted = posMs >= char.startTime;
        if (char.highlighted != shouldBeHighlighted) {
          char.highlighted = shouldBeHighlighted;
          statusChanged = true;
        }
        
        if (posMs >= char.startTime && posMs <= char.endTime) {
          isLineActive = true;
        }
      }

      if (isLineActive || (posMs >= line.startTime && (i == _lyrics.length - 1 || posMs < _lyrics[i + 1].startTime))) {
        newIndex = i;
      }
    }

    if (newIndex != _currentLineIndex) {
      _currentLineIndex = newIndex;
      statusChanged = true;
    }

    if (statusChanged) {
      notifyListeners();
    }
  }

  void clear() {
    _lyrics = [];
    _currentLineIndex = -1;
    _tips = '暂无歌词';
    notifyListeners();
  }
}