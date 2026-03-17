import 'package:flutter/material.dart';
import '../../models/album.dart';
import 'cover_image.dart';
import 'media_card_style.dart';
import 'package:echomusic/theme/app_theme.dart';

enum AlbumCardLayout { grid, list }

class AlbumCard extends StatefulWidget {
  final Album album;
  final AlbumCardLayout layout;
  final VoidCallback? onTap;
  final String? subtitle;
  final int titleMaxLines;
  final double coverRadius;
  final bool showShadow;
  final double coverSize;
  final EdgeInsetsGeometry? contentPadding;
  final double tileRadius;
  final TextStyle? titleStyle;
  final TextStyle? subtitleStyle;
  final int coverImageSize;
  static const double _gridFooterHeight = 44;

  const AlbumCard.grid({
    super.key,
    required this.album,
    this.onTap,
    this.subtitle,
    this.titleMaxLines = 1,
    this.coverRadius = 12,
    this.showShadow = true,
    this.titleStyle,
    this.subtitleStyle,
    this.coverImageSize = 260,
  })  : layout = AlbumCardLayout.grid,
        coverSize = 0,
        contentPadding = null,
        tileRadius = 0;

  const AlbumCard.list({
    super.key,
    required this.album,
    this.onTap,
    this.subtitle,
    this.titleMaxLines = 1,
    this.coverRadius = 10,
    this.coverSize = 56,
    this.contentPadding = const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
    this.tileRadius = 14,
    this.titleStyle,
    this.subtitleStyle,
    this.coverImageSize = 240,
  })  : layout = AlbumCardLayout.list,
        showShadow = false;

  @override
  State<AlbumCard> createState() => _AlbumCardState();
}

class _AlbumCardState extends State<AlbumCard> {
  bool _isHovering = false;

  void _setHover(bool hovering) {
    if (_isHovering == hovering) return;
    setState(() => _isHovering = hovering);
  }

  @override
  Widget build(BuildContext context) {
    return widget.layout == AlbumCardLayout.list
        ? _buildList(context)
        : _buildGrid(context);
  }

  Widget _buildGrid(BuildContext context) {
    final theme = Theme.of(context);
    final style = resolveMediaCardStyle(context, showShadow: widget.showShadow);
    final resolvedTitleStyle = widget.titleStyle ??
        TextStyle(
          color: theme.colorScheme.onSurface,
          fontSize: 13,
          fontWeight: AppTheme.fontWeightBold,
          height: 1.1,
        );
    final resolvedSubtitleStyle = widget.subtitleStyle ??
        TextStyle(
          color: theme.colorScheme.onSurfaceVariant,
          fontSize: 11,
          fontWeight: AppTheme.fontWeightSemiBold,
        );

    return MouseRegion(
      onEnter: (_) => _setHover(true),
      onExit: (_) => _setHover(false),
      child: GestureDetector(
        onTap: widget.onTap,
        child: AnimatedScale(
          scale: _isHovering ? 1.03 : 1.0,
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOutCubic,
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 200),
            curve: Curves.easeOutCubic,
            padding: const EdgeInsets.all(10),
            decoration: BoxDecoration(
              color: style.backgroundColor,
              borderRadius: BorderRadius.circular(widget.coverRadius + 6),
              boxShadow: style.shadows,
            ),
            child: LayoutBuilder(
              builder: (context, constraints) {
                final coverHeight =
                    (constraints.maxHeight - AlbumCard._gridFooterHeight)
                        .clamp(0.0, constraints.maxHeight);
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SizedBox(
                      height: coverHeight,
                      child: ClipRRect(
                        borderRadius: BorderRadius.circular(widget.coverRadius),
                        child: CoverImage(
                          url: widget.album.pic,
                          fit: BoxFit.cover,
                          borderRadius: widget.coverRadius,
                          showShadow: false,
                          size: widget.coverImageSize,
                        ),
                      ),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      widget.album.name,
                      maxLines: widget.titleMaxLines,
                      overflow: TextOverflow.ellipsis,
                      style: resolvedTitleStyle,
                    ),
                    if (widget.subtitle != null) ...[
                      const SizedBox(height: 2),
                      Text(
                        widget.subtitle!,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: resolvedSubtitleStyle,
                      ),
                    ],
                  ],
                );
              },
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildList(BuildContext context) {
    final theme = Theme.of(context);
    final style = resolveMediaCardStyle(context, showShadow: false);
    final resolvedTitleStyle = widget.titleStyle ??
        TextStyle(
          color: theme.colorScheme.onSurface,
          fontSize: 14,
          fontWeight: AppTheme.fontWeightBold,
        );
    final resolvedSubtitleStyle = widget.subtitleStyle ??
        theme.textTheme.bodySmall?.copyWith(
          fontWeight: AppTheme.fontWeightSemiBold,
          color: theme.colorScheme.onSurfaceVariant,
        );
    final subtitleText = widget.subtitle ?? _defaultSubtitle();

    return MouseRegion(
      onEnter: (_) => _setHover(true),
      onExit: (_) => _setHover(false),
      child: GestureDetector(
        onTap: widget.onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOutCubic,
          padding: widget.contentPadding,
          decoration: BoxDecoration(
            color: _isHovering ? style.hoverOverlayColor : style.backgroundColor,
            borderRadius: BorderRadius.circular(widget.tileRadius),
            boxShadow: const <BoxShadow>[],
          ),
          child: Row(
            children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(widget.coverRadius),
                child: CoverImage(
                  url: widget.album.pic,
                  width: widget.coverSize,
                  height: widget.coverSize,
                  borderRadius: widget.coverRadius,
                  showShadow: false,
                  size: widget.coverImageSize,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      widget.album.name,
                      maxLines: widget.titleMaxLines,
                      overflow: TextOverflow.ellipsis,
                      style: resolvedTitleStyle,
                    ),
                    if (subtitleText != null) ...[
                      const SizedBox(height: 4),
                      Text(
                        subtitleText,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: resolvedSubtitleStyle,
                      ),
                    ],
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  String? _defaultSubtitle() {
    final parts = <String>[];
    if (widget.album.singerName.isNotEmpty) parts.add(widget.album.singerName);
    if (widget.album.publishTime.isNotEmpty) parts.add(widget.album.publishTime);
    if (widget.album.songCount > 0) {
      parts.add('${widget.album.songCount} 首歌曲');
    }
    if (parts.isEmpty) return null;
    return parts.join(' • ');
  }
}
