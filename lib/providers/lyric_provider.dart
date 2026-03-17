import 'dart:async';
import 'dart:convert';
import 'package:flutter/material.dart';
import 'persistence_provider.dart';

class LyricCharacter {
  final String text;
  final int startTime;
  final int endTime;
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

  LyricLine({required this.characters, this.translated, this.romanized});

  String get text => characters.map((c) => c.text).join('');
  int get startTime => characters.first.startTime;
  int get endTime => characters.last.endTime;
}

enum LyricsMode { none, translation, romanization }

class LyricProvider with ChangeNotifier {
  List<LyricLine> _lyrics = [];
  int _currentLineIndex = -1;
  String _tips = '暂无歌词';
  LyricsMode _lyricsMode = LyricsMode.none;
  bool _hasTranslation = false;
  bool _hasRomanization = false;

  bool _isPageOpen = false;
  String? _loadedHash;

  PersistenceProvider? _persistenceProvider;
  LyricsMode _preferredMode = LyricsMode.none;
  double _fontScale = 1.0;
  int _fontWeightIndex = 4; // Default to w500 (Medium)

  List<LyricLine> get lyrics => _lyrics;
  int get currentLineIndex => _currentLineIndex;
  String get tips => _tips;
  LyricsMode get lyricsMode => _lyricsMode;
  bool get hasTranslation => _hasTranslation;
  bool get hasRomanization => _hasRomanization;
  bool get isPageOpen => _isPageOpen;
  String? get loadedHash => _loadedHash;
  double get fontScale => _fontScale;
  int get fontWeightIndex => _fontWeightIndex;

  FontWeight get lyricFontWeight {
    const weights = [
      FontWeight.w100,
      FontWeight.w200,
      FontWeight.w300,
      FontWeight.w400,
      FontWeight.w500,
      FontWeight.w600,
      FontWeight.w700,
      FontWeight.w800,
      FontWeight.w900,
    ];
    return weights[_fontWeightIndex.clamp(0, 8)];
  }

  void setPersistenceProvider(PersistenceProvider p) {
    _persistenceProvider = p;
    _preferredMode = _parsePreference(
      p.settings['lyricsModePreference']?.toString(),
    );
    _fontScale = _parseFontScale(p.settings['lyricFontScale']);
    _fontWeightIndex = _parseFontWeightIndex(p.settings['lyricFontWeightIndex']);
  }

  double _parseFontScale(dynamic value) {
    if (value is num) {
      return value.toDouble().clamp(0.7, 1.4);
    }
    final parsed = double.tryParse(value?.toString() ?? '');
    if (parsed == null) return 1.0;
    return parsed.clamp(0.7, 1.4);
  }

  int _parseFontWeightIndex(dynamic value) {
    if (value is num) {
      return value.toInt().clamp(0, 8);
    }
    final parsed = int.tryParse(value?.toString() ?? '');
    if (parsed == null) return 8; // Default to w900
    return parsed.clamp(0, 8);
  }

  Future<void> _persistFontScale(double scale) async {
    _fontScale = scale;
    if (_persistenceProvider != null) {
      await _persistenceProvider!.updateSetting(
        'lyricFontScale',
        _fontScale,
      );
    }
  }

  Future<void> _persistFontWeightIndex(int index) async {
    _fontWeightIndex = index;
    if (_persistenceProvider != null) {
      await _persistenceProvider!.updateSetting(
        'lyricFontWeightIndex',
        _fontWeightIndex,
      );
    }
  }

  Future<void> updateFontScale(double scale) async {
    final next = scale.clamp(0.7, 1.4);
    if (next == _fontScale) return;
    await _persistFontScale(next);
    notifyListeners();
  }

  Future<void> updateFontWeight(int index) async {
    final next = index.clamp(0, 8);
    if (next == _fontWeightIndex) return;
    await _persistFontWeightIndex(next);
    notifyListeners();
  }

  void setPageOpen(bool open) {
    _isPageOpen = open;
    if (open) {
      notifyListeners();
    }
  }

  bool get showTranslation =>
      _lyricsMode == LyricsMode.translation && _hasTranslation;
  bool get showRomanization =>
      _lyricsMode == LyricsMode.romanization && _hasRomanization;

  LyricsMode _parsePreference(String? value) {
    switch (value) {
      case 'translation':
        return LyricsMode.translation;
      case 'romanization':
        return LyricsMode.romanization;
      default:
        return LyricsMode.none;
    }
  }

  Future<void> _persistPreference(LyricsMode mode) async {
    _preferredMode = mode;
    if (_persistenceProvider != null) {
      await _persistenceProvider!.updateSetting(
        'lyricsModePreference',
        _preferredMode.name,
      );
    }
  }

  void _applyPreferredMode() {
    if (_preferredMode == LyricsMode.translation && _hasTranslation) {
      _lyricsMode = LyricsMode.translation;
      return;
    }
    if (_preferredMode == LyricsMode.romanization && _hasRomanization) {
      _lyricsMode = LyricsMode.romanization;
      return;
    }
    _lyricsMode = LyricsMode.none;
  }

  void _resetLyricsState({String? hash, String tips = '暂无歌词'}) {
    _lyrics = [];
    _hasTranslation = false;
    _hasRomanization = false;
    _currentLineIndex = -1;
    _lyricsMode = LyricsMode.none;
    _loadedHash = hash;
    _tips = tips;
  }

  void beginLoading({String? hash}) {
    _resetLyricsState(hash: hash, tips: '歌词加载中...');
    notifyListeners();
  }

  void toggleLyricsMode() {
    if (_lyricsMode == LyricsMode.none) {
      if (_hasTranslation) {
        _lyricsMode = LyricsMode.translation;
      } else if (_hasRomanization) {
        _lyricsMode = LyricsMode.romanization;
      } else {
        _lyricsMode = LyricsMode.none;
      }
    } else if (_lyricsMode == LyricsMode.translation) {
      if (_hasRomanization) {
        _lyricsMode = LyricsMode.romanization;
      } else {
        _lyricsMode = LyricsMode.none;
      }
    } else {
      _lyricsMode = LyricsMode.none;
    }

    unawaited(_persistPreference(_lyricsMode));
    notifyListeners();
  }

  void parseLyrics(Map<String, dynamic> lyricData, {String? hash}) {
    _resetLyricsState(hash: hash);

    final String content =
        (lyricData['decodeContent'] ?? lyricData['lyric'] ?? '').toString();
    if (content.isEmpty) {
      notifyListeners();
      return;
    }

    final List<String> lines = content.split('\n');
    List<dynamic>? translationLyrics;
    List<dynamic>? romanizationLyrics;

    try {
      String languageLine = '';
      for (final String line in lines) {
        if (line.startsWith('[language:')) {
          languageLine = line;
          break;
        }
      }

      if (languageLine.isNotEmpty) {
        final languageCode = languageLine.substring(
          10,
          languageLine.length - 1,
        );
        if (languageCode.isNotEmpty) {
          final cleanedCode = languageCode.replaceAll(
            RegExp(r'[^A-Za-z0-9+/=]'),
            '',
          );
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
      // Silent catch
    }

    final charRegex = RegExp(r'<(\d+),(\d+),\d+>([^<]+)');
    final parsedLines = <LyricLine>[];

    for (var line in lines) {
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

            characters.add(
              LyricCharacter(
                text: charText,
                startTime: charStart,
                endTime: charStart + charDuration,
              ),
            );
          }
        } else {
          final duration = int.parse(lineMatch.group(2)!);
          final text = lineContent.replaceAll(RegExp(r'<.*?>'), '').trim();
          if (text.isNotEmpty) {
            for (int i = 0; i < text.length; i++) {
              characters.add(
                LyricCharacter(
                  text: text[i],
                  startTime: lineStart + (i * duration ~/ text.length),
                  endTime: lineStart + ((i + 1) * duration ~/ text.length),
                ),
              );
            }
          }
        }

        if (characters.isNotEmpty) {
          parsedLines.add(LyricLine(characters: characters));
        }
        continue;
      }

      final lrcMatch = RegExp(r'^\[(\d+):(\d+\.\d+)\](.*)').firstMatch(line);
      if (lrcMatch != null) {
        final minutes = int.parse(lrcMatch.group(1)!);
        final seconds = double.parse(lrcMatch.group(2)!);
        final text = lrcMatch.group(3)!.trim();
        final startTime = (minutes * 60 * 1000 + seconds * 1000).toInt();

        if (text.isNotEmpty) {
          parsedLines.add(
            LyricLine(
              characters: [
                LyricCharacter(
                  text: text,
                  startTime: startTime,
                  endTime: startTime + 3000,
                ),
              ],
            ),
          );
        }
      }
    }

    for (int i = 0; i < parsedLines.length; i++) {
      String? trans;
      String? roman;

      if (translationLyrics != null && i < translationLyrics.length) {
        final transLine = translationLyrics[i];
        if (transLine is List && transLine.isNotEmpty) {
          trans = transLine[0].toString();
          if (trans.isNotEmpty) _hasTranslation = true;
        }
      }

      if (romanizationLyrics != null && i < romanizationLyrics.length) {
        final romanLine = romanizationLyrics[i];
        if (romanLine is List) {
          roman = romanLine.join('');
          if (roman.isNotEmpty) _hasRomanization = true;
        }
      }

      _lyrics.add(
        LyricLine(
          characters: parsedLines[i].characters,
          translated: trans,
          romanized: roman,
        ),
      );
    }

    _tips = _lyrics.isEmpty ? '暂无歌词' : '歌词已加载';
    _applyPreferredMode();
    notifyListeners();
  }

  /// Optimized Update Strategy: Incremental search with configurable offset
  void updateHighlight(Duration position) {
    if (_lyrics.isEmpty) return;

    // Apply user-defined offset (positive offset means delay highlighting)
    final offset = _persistenceProvider?.settings['lyricOffset'] ?? 0;
    final posMs = position.inMilliseconds - (offset as int);

    int newIndex = -1;
    bool needsNotify = false;

    // 1. Efficient Line Selection
    int startSearchIdx = _currentLineIndex >= 0 ? _currentLineIndex : 0;
    if (posMs < _lyrics[startSearchIdx].startTime) {
      startSearchIdx = 0;
    }

    for (int i = startSearchIdx; i < _lyrics.length; i++) {
      if (posMs >= _lyrics[i].startTime &&
          (i == _lyrics.length - 1 || posMs < _lyrics[i + 1].startTime)) {
        newIndex = i;
        break;
      }
    }

    if (newIndex != _currentLineIndex) {
      needsNotify =
          _setLineHighlightState(_currentLineIndex, false) || needsNotify;
    }

    // 2. Character Highlight Update
    if (newIndex != -1) {
      final line = _lyrics[newIndex];
      for (var char in line.characters) {
        final shouldHighlight = posMs >= char.startTime;
        if (char.highlighted != shouldHighlight) {
          char.highlighted = shouldHighlight;
          needsNotify = true;
        }
      }
    }

    // 3. Line Transition Update
    if (newIndex != _currentLineIndex) {
      _currentLineIndex = newIndex;
      needsNotify = true;
    }

    if (needsNotify) {
      notifyListeners();
    }
  }

  bool _setLineHighlightState(int index, bool highlighted) {
    if (index < 0 || index >= _lyrics.length) return false;

    bool changed = false;
    for (final char in _lyrics[index].characters) {
      if (char.highlighted != highlighted) {
        char.highlighted = highlighted;
        changed = true;
      }
    }
    return changed;
  }

  void clear({String? hash, String tips = '暂无歌词'}) {
    _resetLyricsState(hash: hash, tips: tips);
    notifyListeners();
  }
}
