import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter/gestures.dart';
import 'package:provider/provider.dart';
import 'package:audio_video_progress_bar/audio_video_progress_bar.dart';
import '../../models/song.dart';
import '../../theme/app_theme.dart';
import 'package:echomusic/providers/audio_provider.dart';
import 'package:echomusic/providers/persistence_provider.dart';
import 'package:echomusic/providers/user_provider.dart';
import 'package:echomusic/ui/widgets/app_shortcuts.dart';
import '../../utils/constants.dart';
import 'package:echomusic/providers/navigation_provider.dart';
import '../screens/lyric_page.dart';
import 'cover_image.dart';
import 'queue_drawer.dart';
import 'app_menu.dart';
import 'custom_toast.dart';

String _shortcutLabel(BuildContext context, AppShortcutCommand command) {
  final settings = context.watch<PersistenceProvider>().settings;
  return AppShortcuts.labelForSettings(command, settings);
}

bool _showShortcutHint(BuildContext context) {
  final settings = context.watch<PersistenceProvider>().settings;
  return settings['globalShortcutsEnabled'] ?? false;
}

String _tooltipWithShortcut(
  BuildContext context,
  String label,
  AppShortcutCommand command,
) {
  if (!_showShortcutHint(context)) return label;
  return '$label · ${_shortcutLabel(context, command)}';
}

String _volumeTooltip(BuildContext context) {
  if (!_showShortcutHint(context)) return '音量';
  return '音量：${_shortcutLabel(context, AppShortcutCommand.volumeUp)} / '
      '${_shortcutLabel(context, AppShortcutCommand.volumeDown)} / '
      '${_shortcutLabel(context, AppShortcutCommand.toggleMute)}';
}

const EdgeInsets _playerTitleActionPadding =
    EdgeInsets.fromLTRB(6, 8, 6, 0);
const double _playerTitleMarqueeMaxDistance = 220;
const Duration _playerTitleMarqueePause = Duration(seconds: 1);
const Duration _playerTitleMarqueeHoverDelay = Duration(milliseconds: 500);

class PlayerBar extends StatelessWidget {
  const PlayerBar({super.key});

  static const double height = 84;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final modernTheme = theme.extension<AppModernTheme>();

    return SizedBox(
      height: height,
      child: Center(
        child: Container(
          margin: const EdgeInsets.symmetric(vertical: 4, horizontal: 2),
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
          decoration: BoxDecoration(
            color: modernTheme?.playerBarColor ?? theme.colorScheme.surface,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(
              color: (modernTheme?.dividerColor ?? theme.dividerColor).withAlpha(
                40,
              ),
              width: 0.8,
            ),
            boxShadow: [
              BoxShadow(
                color: Colors.black.withAlpha(26),
                blurRadius: 24,
                offset: const Offset(0, 10),
              ),
              BoxShadow(
                color: Colors.black.withAlpha(12),
                blurRadius: 6,
                offset: const Offset(0, 2),
              ),
            ],
          ),
          child: const _PlayerMainContent(),
        ),
      ),
    );
  }
}

class _PlayerMainContent extends StatelessWidget {
  const _PlayerMainContent();

  static const double _centerMinWidth = 280;
  static const double _centerMaxWidth = 420;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Selector<AudioProvider, bool>(
      selector: (_, p) => p.currentSong == null,
      builder: (context, isEmpty, child) {
        if (isEmpty) return _buildEmptyState(context);
        return _buildPlayerContent(context);
      },
    );
  }

  Widget _buildEmptyState(BuildContext context) {
    final theme = Theme.of(context);
    return Stack(
      fit: StackFit.expand,
      children: [
        Align(
          alignment: Alignment.centerLeft,
          child: SizedBox(
            width: _PlayerSongInfo.width,
            child: Row(
              children: [
                Container(
                  width: 50,
                  height: 50,
                  decoration: BoxDecoration(
                    color: theme.colorScheme.onSurface.withAlpha(10),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Icon(
                    CupertinoIcons.music_note,
                    color: theme.colorScheme.onSurface.withAlpha(50),
                  ),
                ),
                const SizedBox(width: 12),
                Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Container(
                      width: 120,
                      height: 12,
                      decoration: BoxDecoration(
                        color: theme.colorScheme.onSurface.withAlpha(10),
                        borderRadius: BorderRadius.circular(4),
                      ),
                    ),
                    const SizedBox(height: 6),
                    Container(
                      width: 80,
                      height: 10,
                      decoration: BoxDecoration(
                        color: theme.colorScheme.onSurface.withAlpha(10),
                        borderRadius: BorderRadius.circular(4),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
        Center(
          child: SizedBox(
            width: _centerMinWidth,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    _PlayerIconButton(
                      icon: CupertinoIcons.repeat,
                      onPressed: null,
                      size: 20,
                    ),
                    const SizedBox(width: 14),
                    _PlayerIconButton(
                      icon: CupertinoIcons.backward_fill,
                      onPressed: null,
                      size: 22,
                    ),
                    const SizedBox(width: 16),
                    Container(
                      width: 44,
                      height: 44,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: theme.colorScheme.onSurface.withAlpha(5),
                      ),
                      child: Center(
                        child: Icon(
                          CupertinoIcons.play_fill,
                          size: 24,
                          color: theme.disabledColor,
                        ),
                      ),
                    ),
                    const SizedBox(width: 16),
                    _PlayerIconButton(
                      icon: CupertinoIcons.forward_fill,
                      onPressed: null,
                      size: 22,
                    ),
                    const SizedBox(width: 14),
                    _PlayerIconButton(
                      icon: CupertinoIcons.speaker_2_fill,
                      onPressed: null,
                      size: 20,
                    ),
                  ],
                ),
                const SizedBox(height: 6),
                SizedBox(
                  width: _centerMinWidth,
                  height: 18,
                  child: Row(
                    children: [
                      Container(
                        width: 36,
                        height: 10,
                        decoration: BoxDecoration(
                          color: theme.colorScheme.onSurface.withAlpha(8),
                          borderRadius: BorderRadius.circular(6),
                        ),
                      ),
                      const SizedBox(width: 10),
                      Expanded(
                        child: Container(
                          height: 3,
                          decoration: BoxDecoration(
                            color: theme.colorScheme.onSurface.withAlpha(12),
                            borderRadius: BorderRadius.circular(2),
                          ),
                        ),
                      ),
                      const SizedBox(width: 10),
                      Container(
                        width: 36,
                        height: 10,
                        decoration: BoxDecoration(
                          color: theme.colorScheme.onSurface.withAlpha(8),
                          borderRadius: BorderRadius.circular(6),
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
        Align(
          alignment: Alignment.centerRight,
          child: SizedBox(
            width: _PlayerRightActions.width,
            child: Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: const [
                _PlayerIconButton(icon: CupertinoIcons.speedometer, onPressed: null),
                SizedBox(width: 6),
                _PlayerIconButton(icon: CupertinoIcons.waveform, onPressed: null),
                SizedBox(width: 6),
                _PlayerIconButton(icon: CupertinoIcons.list_bullet, onPressed: null),
              ],
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildPlayerContent(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final availableWidth = constraints.maxWidth -
            _PlayerSongInfo.width -
            _PlayerRightActions.width -
            24;
        final targetWidth = math.min(
          _centerMaxWidth,
          math.max(_centerMinWidth, availableWidth),
        );

        return Stack(
          fit: StackFit.expand,
          children: [
            const Align(
              alignment: Alignment.centerLeft,
              child: _PlayerSongInfo(),
            ),
            Center(
              child: SizedBox(
                width: targetWidth,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    const _PlayerCenterControls(),
                    const SizedBox(height: 5),
                    SizedBox(
                      width: targetWidth,
                      child: const _InlineProgressRow(),
                    ),
                  ],
                ),
              ),
            ),
            const Align(
              alignment: Alignment.centerRight,
              child: _PlayerRightActions(),
            ),
          ],
        );
      },
    );
  }
}

class _PlayerSongInfo extends StatelessWidget {
  const _PlayerSongInfo();

  static const double width = 260;

  List<SingerInfo> _displaySingers(Song song) => song.singers
      .where((singer) => Song.normalizeDisplayText(singer.name).isNotEmpty)
      .toList(growable: false);

  void _openArtistDetail(BuildContext context, SingerInfo singer) {
    if (singer.id <= 0) {
      CustomToast.error(context, '暂无歌手信息');
      return;
    }
    if (context.read<NavigationProvider>().isCurrentRoute(
      'artist_detail',
      id: singer.id,
    )) {
      return;
    }
    context.read<NavigationProvider>().openArtist(
      singer.id,
      Song.normalizeDisplayText(singer.name),
    );
  }

  void _openAlbumDetail(BuildContext context, Song song) {
    final albumId = int.tryParse(song.albumId ?? '0') ?? 0;
    if (albumId <= 0 || song.albumName.trim().isEmpty) {
      CustomToast.error(context, '暂无专辑信息');
      return;
    }
    if (context.read<NavigationProvider>().isCurrentRoute(
      'album_detail',
      id: albumId,
    )) {
      return;
    }
    context.read<NavigationProvider>().openAlbum(
      albumId,
      song.displayAlbumName,
    );
  }

  Widget _buildMetaLink({
    required String text,
    required TextStyle style,
    VoidCallback? onTap,
    String? tooltip,
  }) {
    final displayText = Song.normalizeDisplayText(text);
    final enabled = onTap != null && text.trim().isNotEmpty;
    final child = MouseRegion(
      cursor: enabled ? SystemMouseCursors.click : MouseCursor.defer,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: Text(
          displayText,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: style,
        ),
      ),
    );

    final tooltipText = Song.normalizeDisplayText(tooltip ?? text);
    if (tooltipText.isEmpty) return child;

    return Tooltip(
      message: tooltipText,
      waitDuration: const Duration(milliseconds: 300),
      child: child,
    );
  }

  Widget _buildSingerLinks({
    required BuildContext context,
    required Song song,
    required TextStyle style,
    required NavigationProvider navigationProvider,
  }) {
    return _buildSingerOnlyText(
      context: context,
      song: song,
      style: style,
      navigationProvider: navigationProvider,
    );
  }

  Widget _buildSingerOnlyText({
    required BuildContext context,
    required Song song,
    required TextStyle style,
    required NavigationProvider navigationProvider,
  }) {
    final spans = _buildSingerSpans(
      context: context,
      song: song,
      style: style,
      navigationProvider: navigationProvider,
    );
    return Text.rich(
      TextSpan(children: spans),
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      softWrap: false,
    );
  }

  List<InlineSpan> _buildSingerSpans({
    required BuildContext context,
    required Song song,
    required TextStyle style,
    required NavigationProvider navigationProvider,
  }) {
    final singers = _displaySingers(song);
    if (singers.isEmpty) {
      return [
        TextSpan(
          text: song.displaySingerName,
          style: style,
        ),
      ];
    }

    final spans = <InlineSpan>[];
    for (int index = 0; index < singers.length; index++) {
      final singer = singers[index];
      final canOpenSinger = !navigationProvider.isCurrentRoute(
        'artist_detail',
        id: singer.id,
      );
      spans.add(
        TextSpan(
          text: Song.normalizeDisplayText(singer.name),
          style: style,
          recognizer: canOpenSinger
              ? (TapGestureRecognizer()
                  ..onTap = () => _openArtistDetail(context, singer))
              : null,
        ),
      );
      if (index < singers.length - 1) {
        spans.add(
          TextSpan(
            text: ' / ',
            style: style.copyWith(color: style.color?.withAlpha(180)),
          ),
        );
      }
    }
    return spans;
  }

  List<InlineSpan> _buildTitleLineSpans({
    required BuildContext context,
    required Song song,
    required TextStyle titleStyle,
    required TextStyle singerStyle,
    required NavigationProvider navigationProvider,
  }) {
    return <InlineSpan>[
      TextSpan(
        text: song.name,
        style: titleStyle,
        recognizer: TapGestureRecognizer()
          ..onTap = () => Navigator.push(
                context,
                CupertinoPageRoute(builder: (_) => const LyricPage()),
              ),
      ),
      TextSpan(
        text: ' - ',
        style: singerStyle,
      ),
      ..._buildSingerSpans(
        context: context,
        song: song,
        style: singerStyle,
        navigationProvider: navigationProvider,
      ),
    ];
  }

  Widget _buildTitleLine({
    required BuildContext context,
    required Song song,
    required TextStyle titleStyle,
    required TextStyle singerStyle,
    required NavigationProvider navigationProvider,
  }) {
    final spans = _buildTitleLineSpans(
      context: context,
      song: song,
      titleStyle: titleStyle,
      singerStyle: singerStyle,
      navigationProvider: navigationProvider,
    );
    final textKey = '${song.name}-${song.displaySingerName}';

    return _HoverMarqueeText(
      spans: spans,
      textKey: textKey,
      maxScrollDistance: _playerTitleMarqueeMaxDistance,
      pauseDuration: _playerTitleMarqueePause,
      scrollOnHover: true,
      hoverStartDelay: _playerTitleMarqueeHoverDelay,
    );
  }

  Widget _buildTitleActions(
    BuildContext context,
    Song song,
    Color accentColor,
  ) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (song.source == 'cloud')
          _PlayerIconButton(
            icon: CupertinoIcons.cloud_fill,
            size: 16,
            padding: _playerTitleActionPadding,
            activeColor: accentColor,
            isSelected: true,
            onPressed: () {},
            tooltip: '云盘歌曲',
          ),
        const _FavoriteButton(padding: _playerTitleActionPadding),
        _PlayerIconButton(
          icon: CupertinoIcons.chat_bubble_text,
          size: 18,
          padding: _playerTitleActionPadding,
          tooltip: '详情及评论',
          onPressed: () =>
              context.read<NavigationProvider>().openSongComment(song),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final accentColor = theme.colorScheme.primary;

    return Selector<AudioProvider, Song?>(
      selector: (_, p) => p.currentSong,
      builder: (context, song, child) {
        if (song == null) return const SizedBox.shrink();

        final navigationProvider = context.watch<NavigationProvider>();
        final albumId = int.tryParse(song.albumId ?? '0') ?? 0;
        final isCurrentAlbumDetail = context.select<NavigationProvider, bool>(
          (provider) => provider.isCurrentRoute('album_detail', id: albumId),
        );
        final canOpenAlbum = albumId > 0 && song.albumName.trim().isNotEmpty;

        final titleStyle = TextStyle(
          color: theme.colorScheme.onSurface,
          fontSize: 14,
          fontWeight: FontWeight.w800,
          height: 1.15,
        );
        final singerStyle = TextStyle(
          color: theme.colorScheme.onSurface.withAlpha(160),
          fontSize: 12,
          fontWeight: FontWeight.w600,
          height: 1.15,
        );
        return SizedBox(
          width: width,
          child: Row(
            children: [
              InkWell(
                onTap: () => Navigator.push(
                  context,
                  CupertinoPageRoute(builder: (_) => const LyricPage()),
                ),
                borderRadius: BorderRadius.circular(12),
                child: Hero(
                  tag: 'player_cover',
                  child: CoverImage(
                    url: song.cover,
                    width: 56,
                    height: 56,
                    borderRadius: 10,
                    size: 120,
                    showShadow: true,
                  ),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.only(right: 12),
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Padding(
                        padding: const EdgeInsets.only(top: 2),
                        child: _buildTitleLine(
                          context: context,
                          song: song,
                          titleStyle: titleStyle,
                          singerStyle: singerStyle,
                          navigationProvider: navigationProvider,
                        ),
                      ),
                      const SizedBox(height: 3),
                      _buildTitleActions(context, song, accentColor),
                    ],
                  ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

class _FavoriteButton extends StatelessWidget {
  final EdgeInsetsGeometry padding;

  const _FavoriteButton({this.padding = const EdgeInsets.all(8)});

  @override
  Widget build(BuildContext context) {
    final userProvider = context.watch<UserProvider>();

    return Selector2<
      AudioProvider,
      PersistenceProvider,
      ({dynamic song, bool isFav})
    >(
      selector: (_, a, p) => (
        song: a.currentSong,
        isFav: a.currentSong != null ? p.isFavorite(a.currentSong!) : false,
      ),
      builder: (context, data, child) {
        if (data.song == null || !userProvider.isAuthenticated) {
          return const SizedBox.shrink();
        }

        return _PlayerIconButton(
          icon: data.isFav ? CupertinoIcons.heart_fill : CupertinoIcons.heart,
          isSelected: data.isFav,
          activeColor: Colors.redAccent,
          padding: padding,
          onPressed: () => context.read<PersistenceProvider>().toggleFavorite(
            data.song,
            userProvider: userProvider,
          ),
          size: 20,
          tooltip: _tooltipWithShortcut(
            context,
            data.isFav ? '取消收藏' : '收藏',
            AppShortcutCommand.toggleFavorite,
          ),
        );
      },
    );
  }
}

class _HoverMarqueeText extends StatefulWidget {
  final List<InlineSpan> spans;
  final String textKey;
  final double gap;
  final double speed;
  final double maxScrollDistance;
  final Duration pauseDuration;
  final bool scrollOnHover;
  final Duration hoverStartDelay;

  const _HoverMarqueeText({
    required this.spans,
    required this.textKey,
    this.gap = 28,
    this.speed = 28,
    this.maxScrollDistance = double.infinity,
    this.pauseDuration = Duration.zero,
    this.scrollOnHover = false,
    this.hoverStartDelay = Duration.zero,
  });

  @override
  State<_HoverMarqueeText> createState() => _HoverMarqueeTextState();
}

class _HoverMarqueeTextState extends State<_HoverMarqueeText> {
  static const double _scrollStep = 2.5;
  Duration _scrollTick = const Duration(milliseconds: 80);
  final ValueNotifier<double> _offsetNotifier = ValueNotifier(0);
  bool _isHovering = false;
  bool _shouldScroll = false;
  Timer? _restartTimer;
  Timer? _scrollTimer;
  Timer? _hoverStartTimer;
  DateTime? _scrollStart;
  double _distance = 0;
  Duration _scrollDuration = Duration.zero;
  bool _restartFromBeginning = false;

  bool get _allowAutoScroll =>
      widget.scrollOnHover ? _isHovering : !_isHovering;

  @override
  void initState() {
    super.initState();
  }

  @override
  void didUpdateWidget(covariant _HoverMarqueeText oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.textKey != oldWidget.textKey) {
      _resetScrolling(resetOffset: true);
    }
  }

  @override
  void dispose() {
    _restartTimer?.cancel();
    _scrollTimer?.cancel();
    _hoverStartTimer?.cancel();
    _offsetNotifier.dispose();
    super.dispose();
  }

  void _resetScrolling({required bool resetOffset}) {
    _restartTimer?.cancel();
    _scrollTimer?.cancel();
    _hoverStartTimer?.cancel();
    _scrollTimer = null;
    _scrollStart = null;
    _restartFromBeginning = false;
    if (resetOffset) _offsetNotifier.value = 0;
  }

  void _setOffset(double offset) {
    if ((_offsetNotifier.value - offset).abs() < 0.5) return;
    _offsetNotifier.value = offset;
  }

  void _scheduleRestart() {
    _restartTimer?.cancel();
    if (!_shouldScroll || !_allowAutoScroll) return;
    final shouldReset = _restartFromBeginning;
    _restartFromBeginning = false;
    if (widget.pauseDuration == Duration.zero) {
      _startScroll(resetToStart: shouldReset);
      return;
    }
    _restartTimer = Timer(widget.pauseDuration, () {
      if (!mounted || !_shouldScroll || !_allowAutoScroll) return;
      _startScroll(resetToStart: shouldReset);
    });
  }

  void _startScroll({bool resetToStart = false}) {
    _restartTimer?.cancel();
    if (!_shouldScroll || !_allowAutoScroll || _distance <= 0) return;
    if (_scrollDuration == Duration.zero) return;

    if (resetToStart || _restartFromBeginning) {
      _restartFromBeginning = false;
      _setOffset(0);
      _scrollStart = DateTime.now();
    } else {
      final currentOffset = _offsetNotifier.value;
      final progress = _distance == 0
          ? 0.0
          : (-currentOffset / _distance).clamp(0.0, 1.0);
      final elapsedMs = (progress * _scrollDuration.inMilliseconds).round();
      _scrollStart = DateTime.now().subtract(Duration(milliseconds: elapsedMs));
    }

    _scrollTimer?.cancel();
    _scrollTimer = Timer.periodic(_scrollTick, (_) => _tickScroll());
    _tickScroll();
  }

  void _tickScroll() {
    if (!mounted) {
      _resetScrolling(resetOffset: false);
      return;
    }
    if (!_shouldScroll || !_allowAutoScroll || _distance <= 0) {
      _resetScrolling(resetOffset: false);
      return;
    }
    final start = _scrollStart;
    if (start == null) return;

    final totalMs = _scrollDuration.inMilliseconds;
    if (totalMs <= 0) return;

    final elapsedMs = DateTime.now().difference(start).inMilliseconds;
    final progress = elapsedMs / totalMs;
    if (progress >= 1) {
      _setOffset(-_distance);
      _scrollTimer?.cancel();
      _scrollTimer = null;
      _restartFromBeginning = true;
      _scheduleRestart();
      return;
    }
    _setOffset(-_distance * progress);
  }

  void _updateAnimation({required double distance, required bool shouldScroll}) {
    final distanceChanged = _distance != distance;
    _shouldScroll = shouldScroll;
    if (!shouldScroll) {
      _resetScrolling(resetOffset: true);
      _distance = distance;
      return;
    }

    _distance = distance;
    _scrollDuration = Duration(
      milliseconds: math.max(1, (distance / widget.speed * 1000).round()),
    );
    final tickMs =
        math.max(40, math.min(160, (1000 * _scrollStep / widget.speed).round()));
    _scrollTick = Duration(milliseconds: tickMs);

    if (widget.scrollOnHover && !_isHovering) {
      _resetScrolling(resetOffset: true);
      return;
    }

    if (distanceChanged) {
      _resetScrolling(resetOffset: true);
    }

    if (_allowAutoScroll && _scrollTimer == null) {
      if (widget.scrollOnHover) {
        _scheduleHoverStart();
      } else {
        _startScroll();
      }
    }
  }

  void _scheduleHoverStart() {
    if (!widget.scrollOnHover) return;
    _hoverStartTimer?.cancel();
    if (!_shouldScroll || !_isHovering) return;
    if (widget.hoverStartDelay == Duration.zero) {
      _startScroll();
      return;
    }
    _hoverStartTimer = Timer(widget.hoverStartDelay, () {
      if (!mounted || !_shouldScroll || !_isHovering) return;
      _startScroll();
    });
  }

  void _setHovering(bool hovering) {
    if (_isHovering == hovering) return;
    setState(() => _isHovering = hovering);
    if (widget.scrollOnHover) {
      if (hovering) {
        _resetScrolling(resetOffset: false);
        _scheduleHoverStart();
      } else {
        _resetScrolling(resetOffset: true);
      }
      return;
    }

    if (hovering) {
      _resetScrolling(resetOffset: false);
    } else {
      if (_shouldScroll && _scrollTimer == null) _startScroll();
    }
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final span = TextSpan(children: widget.spans);
        final textPainter = TextPainter(
          text: span,
          maxLines: 1,
          textDirection: Directionality.of(context),
          textScaler: MediaQuery.textScalerOf(context),
        )..layout();

        final textWidth = textPainter.width;
        final availableWidth = constraints.maxWidth;
        final overflow = textWidth - availableWidth;
        final cappedDistance = overflow > 0
            ? math.min(overflow, widget.maxScrollDistance)
            : 0.0;
        final shouldScroll = cappedDistance > 0;
        final distance = cappedDistance;

        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (!mounted) return;
          _updateAnimation(distance: distance, shouldScroll: shouldScroll);
        });

        if (!shouldScroll) {
          return RichText(
            text: span,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            softWrap: false,
          );
        }

        final content = RichText(text: span);

        return MouseRegion(
          onEnter: (_) => _setHovering(true),
          onExit: (_) => _setHovering(false),
          child: ClipRect(
            child: SizedBox(
              height: textPainter.height,
              child: AnimatedBuilder(
                animation: _offsetNotifier,
                child: content,
                builder: (context, child) {
                  final offset = _offsetNotifier.value;
                  return OverflowBox(
                    minWidth: 0,
                    maxWidth: double.infinity,
                    alignment: Alignment.centerLeft,
                    child: Transform.translate(
                      offset: Offset(offset, 0),
                      child: child,
                    ),
                  );
                },
              ),
            ),
          ),
        );
      },
    );
  }
}

class _PlayPauseButtonIsolated extends StatelessWidget {
  const _PlayPauseButtonIsolated();

  @override
  Widget build(BuildContext context) {
    return Selector<AudioProvider, ({bool playing, bool loading})>(
      selector: (_, p) => (playing: p.isPlaying, loading: p.isLoading),
      builder: (context, state, child) {
        return _PlayPauseButton(
          isPlaying: state.playing,
          isLoading: state.loading,
        );
      },
    );
  }
}

class _PlayerCenterControls extends StatelessWidget {
  const _PlayerCenterControls();

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        const _PlayModeButton(),
        const SizedBox(width: 10),
        _PlayerIconButton(
          icon: CupertinoIcons.backward_fill,
          onPressed: context.read<AudioProvider>().previous,
          size: 22,
          tooltip: _tooltipWithShortcut(
            context,
            '上一首',
            AppShortcutCommand.previousTrack,
          ),
        ),
        const SizedBox(width: 16),
        const _PlayPauseButtonIsolated(),
        const SizedBox(width: 16),
        _PlayerIconButton(
          icon: CupertinoIcons.forward_fill,
          onPressed: context.read<AudioProvider>().next,
          size: 22,
          tooltip: _tooltipWithShortcut(
            context,
            '下一首',
            AppShortcutCommand.nextTrack,
          ),
        ),
        const SizedBox(width: 10),
        const _VolumeButton(),
      ],
    );
  }
}

class _InlineProgressRow extends StatefulWidget {
  const _InlineProgressRow();

  @override
  State<_InlineProgressRow> createState() => _InlineProgressRowState();
}

class _InlineProgressRowState extends State<_InlineProgressRow> {
  bool _isHovering = false;

  void _setHover(bool hovering) {
    if (_isHovering == hovering) return;
    setState(() => _isHovering = hovering);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final accentColor = theme.colorScheme.primary;
    final audioProvider = context.read<AudioProvider>();
    final climaxMarks = context.select<AudioProvider, Map<double, double>>(
      (p) => p.climaxMarks,
    );
    final timeStyle = TextStyle(
      fontSize: 11,
      fontFamily: 'monospace',
      color: theme.colorScheme.onSurface.withAlpha(120),
      fontWeight: FontWeight.w600,
      height: 1.0,
    );
    final positionTextStream = audioProvider.positionSnapshotStream
        .map((snap) => _formatDuration(snap.position))
        .distinct();
    final durationTextStream = audioProvider.positionSnapshotStream
        .map((snap) => _formatDuration(snap.duration))
        .distinct();

    return SizedBox(
      height: 14,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          RepaintBoundary(
            child: SizedBox(
              width: 34,
              child: Align(
                alignment: Alignment.centerLeft,
                child: StreamBuilder<String>(
                  stream: positionTextStream,
                  initialData: _formatDuration(audioProvider.effectivePosition),
                  builder: (context, snapshot) {
                    return Text(
                      snapshot.data ?? '00:00',
                      style: timeStyle,
                    );
                  },
                ),
              ),
            ),
          ),
          const SizedBox(width: 4),
          Expanded(
            child: MouseRegion(
              onEnter: (_) => _setHover(true),
              onExit: (_) => _setHover(false),
              child: LayoutBuilder(
                builder: (context, constraints) {
                  const barHeight = 3.4;
                  const thumbRadius = 4.0;
                  const progressHeight = thumbRadius * 2;
                  const markerWidth = 2.0;
                  const markerHeight = 6.0;
                  final markerTop =
                      (constraints.maxHeight - markerHeight) / 2;
                  final markerDecoration = BoxDecoration(
                    color: accentColor.withAlpha(200),
                    borderRadius: BorderRadius.circular(1),
                  );
                  final markerLayer = climaxMarks.isNotEmpty
                      ? IgnorePointer(
                          child: RepaintBoundary(
                            child: Stack(
                              children: [
                                for (final entry in climaxMarks.entries) ...[
                                  Positioned(
                                    left: (constraints.maxWidth - markerWidth) *
                                        entry.key,
                                    top: markerTop,
                                    child: Container(
                                      width: markerWidth,
                                      height: markerHeight,
                                      decoration: markerDecoration,
                                    ),
                                  ),
                                  if (entry.value > entry.key)
                                    Positioned(
                                      left: (constraints.maxWidth -
                                              markerWidth) *
                                          entry.value,
                                      top: markerTop,
                                      child: Container(
                                        width: markerWidth,
                                        height: markerHeight,
                                        decoration: markerDecoration,
                                      ),
                                    ),
                                ],
                              ],
                            ),
                          ),
                        )
                      : null;

                  return StreamBuilder<PositionSnapshot>(
                    stream: audioProvider.positionSnapshotStream,
                    initialData: PositionSnapshot(
                      audioProvider.effectivePosition,
                      audioProvider.effectiveDuration,
                    ),
                    builder: (context, snapshot) {
                      final snap =
                          snapshot.data ??
                          PositionSnapshot(
                            audioProvider.effectivePosition,
                            audioProvider.effectiveDuration,
                          );
                      return Stack(
                        alignment: Alignment.center,
                        children: [
                          RepaintBoundary(
                            child: Center(
                              child: SizedBox(
                                height: progressHeight,
                                child: ProgressBar(
                                  progress: snap.position,
                                  total: snap.duration,
                                  barHeight: barHeight,
                                  baseBarColor: theme
                                      .colorScheme
                                      .onSurface
                                      .withAlpha(18),
                                  progressBarColor: accentColor,
                                  thumbColor: _isHovering
                                      ? accentColor
                                      : Colors.transparent,
                                  thumbRadius: thumbRadius,
                                  thumbGlowRadius: 0.0,
                                  onSeek: (duration) =>
                                      audioProvider.seek(duration),
                                  onDragStart: (_) =>
                                      audioProvider.notifyDragStart(),
                                  onDragEnd: () =>
                                      audioProvider.notifyDragEnd(),
                                  timeLabelLocation: TimeLabelLocation.none,
                                ),
                              ),
                            ),
                          ),
                          if (markerLayer != null) markerLayer,
                        ],
                      );
                    },
                  );
                },
              ),
            ),
          ),
          const SizedBox(width: 4),
          RepaintBoundary(
            child: SizedBox(
              width: 34,
              child: Align(
                alignment: Alignment.centerRight,
                child: StreamBuilder<String>(
                  stream: durationTextStream,
                  initialData: _formatDuration(audioProvider.effectiveDuration),
                  builder: (context, snapshot) {
                    return Text(
                      snapshot.data ?? '00:00',
                      style: timeStyle,
                    );
                  },
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  String _formatDuration(Duration duration) {
    String twoDigits(int n) => n.toString().padLeft(2, "0");
    return "${twoDigits(duration.inMinutes.remainder(60))}:${twoDigits(duration.inSeconds.remainder(60))}";
  }
}

class _PlayerRightActions extends StatelessWidget {
  const _PlayerRightActions();

  static const double width = 220;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: width,
      child: Row(
        mainAxisAlignment: MainAxisAlignment.end,
        children: [
          const _PlaybackRateButton(),
          const SizedBox(width: 6),
          const _QualityButton(),
          const SizedBox(width: 6),
          const _QueueButton(),
        ],
      ),
    );
  }
}

class _PlayModeButton extends StatelessWidget {
  const _PlayModeButton();

  @override
  Widget build(BuildContext context) {
    return Selector<AudioProvider, String>(
      selector: (_, p) => p.playMode,
      builder: (context, mode, child) {
        IconData icon = CupertinoIcons.repeat;
        String tip = '列表循环';
        if (mode == 'repeat-once') {
          icon = CupertinoIcons.repeat_1;
          tip = '单曲循环';
        } else if (mode == 'shuffle') {
          icon = CupertinoIcons.shuffle;
          tip = '随机播放';
        }

        return PlayerMenuAnchor<void>(
          width: 156,
          height: 176,
          padding: const EdgeInsets.symmetric(vertical: 6),
          targetAnchor: Alignment.topCenter,
          followerAnchor: Alignment.bottomCenter,
          offset: const Offset(0, -10),
          showArrow: true,
          arrowEdge: AppMenuArrowEdge.bottom,
          builder: (context, toggle, isOpen) => _PlayerIconButton(
            icon: icon,
            isSelected: isOpen,
            onPressed: toggle,
            size: 20,
            tooltip: _tooltipWithShortcut(
              context,
              tip,
              AppShortcutCommand.togglePlayMode,
            ),
          ),
          menuBuilder: (context, close) => _PlayModePopup(close: () => close()),
        );
      },
    );
  }
}

class _PlaybackRateButton extends StatelessWidget {
  const _PlaybackRateButton();

  @override
  Widget build(BuildContext context) {
    return Selector<AudioProvider, double>(
      selector: (_, p) => p.playbackRate,
      builder: (context, rate, child) {
        return PlayerMenuAnchor<void>(
          width: 128,
          height: 368,
          padding: const EdgeInsets.symmetric(vertical: 6),
          targetAnchor: Alignment.topCenter,
          followerAnchor: Alignment.bottomCenter,
          offset: const Offset(0, -10),
          showArrow: true,
          arrowEdge: AppMenuArrowEdge.bottom,
          builder: (context, toggle, isOpen) => _PlayerIconButton(
            icon: CupertinoIcons.speedometer,
            isSelected: rate != 1.0 || isOpen,
            onPressed: toggle,
            size: 20,
            tooltip: '播放倍速',
          ),
          menuBuilder: (context, close) => _SpeedPopup(close: () => close()),
        );
      },
    );
  }
}

class _QualityButton extends StatelessWidget {
  const _QualityButton();

  @override
  Widget build(BuildContext context) {
    return Selector<AudioProvider, dynamic>(
      selector: (_, p) => p.currentSong,
      builder: (context, song, child) {
        return PlayerMenuAnchor<void>(
          width: 196,
          height: 380,
          padding: const EdgeInsets.symmetric(vertical: 6),
          targetAnchor: Alignment.topCenter,
          followerAnchor: Alignment.bottomCenter,
          offset: const Offset(0, -10),
          showArrow: true,
          arrowEdge: AppMenuArrowEdge.bottom,
          builder: (context, toggle, isOpen) => _PlayerIconButton(
            icon: CupertinoIcons.waveform,
            onPressed: song?.source == 'cloud' ? null : toggle,
            size: 20,
            tooltip: '音质选择',
            isSelected: isOpen,
          ),
          menuBuilder: (context, close) =>
              _QualityEffectPopup(close: () => close()),
        );
      },
    );
  }
}


class _VolumeButton extends StatelessWidget {
  const _VolumeButton();

  @override
  Widget build(BuildContext context) {
    final audioProvider = context.read<AudioProvider>();
    return StreamBuilder<double>(
      stream: audioProvider.userVolumeStream,
      initialData: audioProvider.displayVolume,
      builder: (context, snapshot) {
        final vol = snapshot.data ?? audioProvider.displayVolume;
        return PlayerMenuAnchor<void>(
          width: 72,
          height: 216,
          padding: const EdgeInsets.fromLTRB(6, 10, 6, 10),
          targetAnchor: Alignment.topCenter,
          followerAnchor: Alignment.bottomCenter,
          offset: const Offset(0, -10),
          showArrow: true,
          arrowEdge: AppMenuArrowEdge.bottom,
          builder: (context, toggle, isOpen) => _PlayerIconButton(
            icon: vol == 0
                ? CupertinoIcons.speaker_slash_fill
                : (vol < 50
                      ? CupertinoIcons.speaker_1_fill
                      : CupertinoIcons.speaker_2_fill),
            isSelected: vol > 0 || isOpen,
            onPressed: toggle,
            onScroll: (delta) {
              final newVol = (vol + (delta > 0 ? -5.0 : 5.0)).clamp(0.0, 100.0);
              audioProvider.setVolume(newVol);
            },
            size: 20,
            tooltip: _volumeTooltip(context),
          ),
          menuBuilder: (context, close) => const _VolumePopup(),
        );
      },
    );
  }
}

class _QueueButton extends StatelessWidget {
  const _QueueButton();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final accentColor = theme.colorScheme.primary;

    return Stack(
      clipBehavior: Clip.none,
      children: [
        _PlayerIconButton(
          icon: CupertinoIcons.list_bullet,
          onPressed: () => _showQueueDrawer(context),
          size: 22,
          tooltip: '播放队列',
        ),
        Selector2<AudioProvider, PersistenceProvider, ({int count, bool show})>(
          selector: (_, a, p) => (
            count: a.playlist.length,
            show: p.settings['showPlaylistCount'] ?? true,
          ),
          builder: (context, data, child) {
            if (!data.show) return const SizedBox.shrink();
            return Positioned(
              top: -2,
              right: -10,
              child: IgnorePointer(
                child: Container(
                  key: const ValueKey('player-queue-count-badge'),
                  padding: const EdgeInsets.symmetric(
                    horizontal: 4,
                    vertical: 0.5,
                  ),
                  decoration: BoxDecoration(
                    color: accentColor,
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(
                      color: theme.colorScheme.surface,
                      width: 1.5,
                    ),
                    boxShadow: [
                      BoxShadow(
                        color: Colors.black.withAlpha(50),
                        blurRadius: 4,
                        offset: const Offset(0, 1),
                      ),
                    ],
                  ),
                  constraints: const BoxConstraints(
                    minWidth: 16,
                    minHeight: 16,
                  ),
                  child: Center(
                    child: Text(
                      data.count > 99 ? '99+' : '${data.count}',
                      style: const TextStyle(
                        color: Colors.white,
                        fontSize: 8,
                        fontWeight: FontWeight.w900,
                        height: 1.1,
                      ),
                    ),
                  ),
                ),
              ),
            );
          },
        ),
      ],
    );
  }
}

void _showQueueDrawer(BuildContext context) {
  final theme = Theme.of(context);
  showGeneralDialog(
    context: context,
    barrierLabel: 'Queue',
    barrierDismissible: true,
    barrierColor: theme.colorScheme.scrim.withAlpha(20),
    transitionDuration: const Duration(milliseconds: 300),
    pageBuilder: (context, _, _) => Align(
      alignment: Alignment.centerRight,
      child: Padding(
        padding: const EdgeInsets.only(bottom: 96),
        child: Material(
          elevation: 20,
          borderRadius: const BorderRadius.horizontal(
            left: Radius.circular(16),
          ),
          child: SizedBox(width: 380, child: const QueueDrawer()),
        ),
      ),
    ),
    transitionBuilder: (context, anim, _, child) => SlideTransition(
      position: Tween<Offset>(
        begin: const Offset(1, 0),
        end: Offset.zero,
      ).animate(CurvedAnimation(parent: anim, curve: Curves.easeOutCubic)),
      child: child,
    ),
  );
}

class _PlayModePopup extends StatelessWidget {
  final VoidCallback close;

  const _PlayModePopup({required this.close});

  @override
  Widget build(BuildContext context) {
    final audio = context.watch<AudioProvider>();
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        _buildPopupHeader(context, '播放模式'),
        _buildPopupItem(
          context,
          label: '列表循环',
          isSelected: audio.playMode == 'repeat',
          icon: CupertinoIcons.repeat,
          onTap: () => audio.setPlayMode('repeat'),
          onAfterTap: close,
        ),
        _buildPopupItem(
          context,
          label: '单曲循环',
          isSelected: audio.playMode == 'repeat-once',
          icon: CupertinoIcons.repeat_1,
          onTap: () => audio.setPlayMode('repeat-once'),
          onAfterTap: close,
        ),
        _buildPopupItem(
          context,
          label: '随机播放',
          isSelected: audio.playMode == 'shuffle',
          icon: CupertinoIcons.shuffle,
          onTap: () => audio.setPlayMode('shuffle'),
          onAfterTap: close,
        ),
      ],
    );
  }
}

class _SpeedPopup extends StatelessWidget {
  final VoidCallback close;

  const _SpeedPopup({required this.close});

  @override
  Widget build(BuildContext context) {
    final audio = context.watch<AudioProvider>();
    return Column(
      children: [
        _buildPopupHeader(context, '播放倍速'),
        Expanded(
          child: ListView(
            padding: EdgeInsets.zero,
            children: PlaySpeed.options
                .map(
                  (s) => _buildPopupItem(
                    context,
                    label: '${s}x',
                    isSelected: audio.playbackRate == s,
                    onTap: () => audio.setPlaybackRate(s),
                    onAfterTap: close,
                  ),
                )
                .toList(),
          ),
        ),
      ],
    );
  }
}

class _QualityEffectPopup extends StatelessWidget {
  final VoidCallback close;

  const _QualityEffectPopup({required this.close});

  @override
  Widget build(BuildContext context) {
    final audio = context.watch<AudioProvider>();
    final persistence = context.watch<PersistenceProvider>();
    final currentQuality = AudioQuality.normalize(
      (persistence.playerSettings['audioQuality'] ??
              persistence.settings['audioQuality'])
          ?.toString(),
    );
    final currentEffect =
        persistence.playerSettings['audioEffect'] ??
        persistence.settings['audioEffect'] ??
        'none';
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _buildPopupHeader(context, '音质选择'),
        ...AudioQuality.options.map(
          (q) => _buildPopupItem(
            context,
            label: q.label,
            isSelected: currentQuality == q.value,
            onTap: () => audio.updateAudioSetting('audioQuality', q.value),
            onAfterTap: close,
          ),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
          child: Divider(
            height: 1,
            color: Theme.of(context).colorScheme.outlineVariant.withAlpha(120),
          ),
        ),
        _buildPopupHeader(context, '音效设置'),
        Expanded(
          child: ListView(
            padding: EdgeInsets.zero,
            children: AudioEffect.options
                .map(
                  (e) => _buildPopupItem(
                    context,
                    label: e.label,
                    isSelected: currentEffect == e.value,
                    onTap: () =>
                        audio.updateAudioSetting('audioEffect', e.value),
                    onAfterTap: close,
                  ),
                )
                .toList(),
          ),
        ),
      ],
    );
  }
}

class _VolumePopup extends StatelessWidget {
  const _VolumePopup();
  @override
  Widget build(BuildContext context) {
    final audio = context.read<AudioProvider>();
    final theme = Theme.of(context);
    return StreamBuilder<double>(
      stream: audio.userVolumeStream,
      initialData: audio.displayVolume,
      builder: (context, snapshot) {
        final vol = snapshot.data ?? audio.displayVolume;
        return Column(
          children: [
            const SizedBox(height: 12),
            Text(
              '${vol.toInt()}%',
              style: const TextStyle(fontSize: 12, fontWeight: FontWeight.bold),
            ),
            Expanded(
              child: RotatedBox(
                quarterTurns: 3,
                child: SliderTheme(
                  data: theme.sliderTheme.copyWith(
                    trackHeight: 4,
                    thumbShape: const RoundSliderThumbShape(
                      enabledThumbRadius: 6,
                    ),
                  ),
                  child: Slider(
                    value: vol,
                    min: 0,
                    max: 100,
                    onChanged: (v) => audio.setVolume(v),
                  ),
                ),
              ),
            ),
            const SizedBox(height: 8),
            MouseRegion(
              cursor: SystemMouseCursors.click,
              child: GestureDetector(
                onTap: () => audio.toggleMute(),
                child: Icon(
                  vol == 0
                      ? CupertinoIcons.speaker_slash_fill
                      : (vol < 50
                            ? CupertinoIcons.speaker_1_fill
                            : CupertinoIcons.speaker_2_fill),
                  size: 18,
                  color: theme.colorScheme.primary,
                ),
              ),
            ),
            const SizedBox(height: 12),
          ],
        );
      },
    );
  }
}

Widget _buildPopupHeader(BuildContext context, String title) =>
    AppMenuSectionLabel(title);

Widget _buildPopupItem(
  BuildContext context, {
  required String label,
  required bool isSelected,
  required VoidCallback onTap,
  IconData? icon,
  VoidCallback? onAfterTap,
}) {
  return Align(
    alignment: Alignment.center,
    child: FractionallySizedBox(
      widthFactor: 0.82,
      child: _PlayerPopupMenuItem(
        label: label,
        isSelected: isSelected,
        icon: icon,
        onPressed: () {
          onTap();
          onAfterTap?.call();
        },
      ),
    ),
  );
}

class _PlayerPopupMenuItem extends StatelessWidget {
  final String label;
  final bool isSelected;
  final IconData? icon;
  final VoidCallback onPressed;

  const _PlayerPopupMenuItem({
    required this.label,
    required this.isSelected,
    required this.onPressed,
    this.icon,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final accentColor = theme.colorScheme.primary;
    final selectedColor = accentColor.withAlpha(18);
    final hoverColor = accentColor.withAlpha(isSelected ? 18 : 12);

    return Container(
      decoration: BoxDecoration(
        color: isSelected ? selectedColor : null,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onPressed,
          borderRadius: BorderRadius.circular(14),
          hoverColor: hoverColor,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            child: Row(
              children: [
                if (icon != null) ...[
                  Icon(
                    icon,
                    size: 16,
                    color: isSelected
                        ? theme.colorScheme.primary
                        : theme.colorScheme.onSurfaceVariant,
                  ),
                  const SizedBox(width: 10),
                ],
                Expanded(
                  child: Text(
                    label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 13,
                      fontWeight: isSelected
                          ? FontWeight.w800
                          : FontWeight.w600,
                      color: isSelected
                          ? theme.colorScheme.primary
                          : theme.colorScheme.onSurface,
                    ),
                  ),
                ),
                if (isSelected)
                  Icon(
                    CupertinoIcons.checkmark_alt,
                    size: 16,
                    color: theme.colorScheme.primary,
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _PlayerIconButton extends StatefulWidget {
  final IconData icon;
  final VoidCallback? onPressed;
  final Function(double)? onScroll;
  final double size;
  final bool isSelected;
  final Color? activeColor;
  final String? tooltip;
  final EdgeInsetsGeometry padding;
  const _PlayerIconButton({
    required this.icon,
    this.onPressed,
    this.onScroll,
    this.size = 20,
    this.isSelected = false,
    this.activeColor,
    this.tooltip,
    this.padding = const EdgeInsets.all(8),
  });
  @override
  State<_PlayerIconButton> createState() => _PlayerIconButtonState();
}

class _PlayerIconButtonState extends State<_PlayerIconButton> {
  bool _isHovered = false;
  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final disabled = widget.onPressed == null;
    final color = disabled
        ? theme.disabledColor
        : (_isHovered || widget.isSelected
              ? (widget.activeColor ?? theme.colorScheme.primary)
              : theme.colorScheme.onSurfaceVariant.withAlpha(180));

    return MouseRegion(
      cursor: disabled ? SystemMouseCursors.basic : SystemMouseCursors.click,
      onEnter: (_) {
        if (!disabled) setState(() => _isHovered = true);
      },
      onExit: (_) {
        if (!disabled) setState(() => _isHovered = false);
      },
      child: Tooltip(
        message: widget.tooltip ?? '',
        waitDuration: const Duration(milliseconds: 500),
        child: GestureDetector(
          onTap: widget.onPressed,
          child: Listener(
            onPointerSignal: (pointerSignal) {
              if (pointerSignal is PointerScrollEvent &&
                  widget.onScroll != null) {
                widget.onScroll!(pointerSignal.scrollDelta.dy);
              }
            },
            child: AnimatedScale(
              scale: _isHovered && !disabled ? 1.15 : 1.0,
              duration: const Duration(milliseconds: 200),
              curve: Curves.easeOutBack,
              child: Container(
                padding: widget.padding,
                color: Colors.transparent,
                child: Icon(widget.icon, size: widget.size, color: color),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _PlayPauseButton extends StatefulWidget {
  final bool isPlaying;
  final bool isLoading;
  const _PlayPauseButton({required this.isPlaying, required this.isLoading});

  @override
  State<_PlayPauseButton> createState() => _PlayPauseButtonState();
}

class _PlayPauseButtonState extends State<_PlayPauseButton> {
  bool _isHovered = false;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Tooltip(
      message: _tooltipWithShortcut(
        context,
        widget.isPlaying ? '暂停' : '播放',
        AppShortcutCommand.togglePlayback,
      ),
      child: MouseRegion(
        cursor: widget.isLoading
            ? SystemMouseCursors.basic
            : SystemMouseCursors.click,
        onEnter: (_) => setState(() => _isHovered = true),
        onExit: (_) => setState(() => _isHovered = false),
        child: GestureDetector(
          onTap: widget.isLoading
              ? null
              : () => context.read<AudioProvider>().togglePlay(),
          child: AnimatedScale(
            scale: _isHovered ? 1.1 : 1.0,
            duration: const Duration(milliseconds: 200),
            curve: Curves.easeOutBack,
            child: Container(
              width: 38,
              height: 38,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: theme.colorScheme.onSurface.withAlpha(15),
              ),
              child: Center(
                child: widget.isLoading
                    ? const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2.0),
                      )
                    : Padding(
                        padding: EdgeInsets.only(
                          left: widget.isPlaying ? 0 : 4,
                        ),
                        child: Icon(
                          widget.isPlaying
                              ? CupertinoIcons.pause_fill
                              : CupertinoIcons.play_fill,
                          size: 20,
                          color: theme.colorScheme.onSurface,
                        ),
                      ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
