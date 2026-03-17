import 'package:flutter/material.dart';
import '../../models/artist.dart';
import 'cover_image.dart';
import 'media_card_style.dart';
import 'package:echomusic/theme/app_theme.dart';

enum ArtistCardLayout { grid, list }

class ArtistCard extends StatefulWidget {
  final Artist artist;
  final ArtistCardLayout layout;
  final VoidCallback? onTap;
  final String? subtitle;
  final int titleMaxLines;
  final double coverSize;
  final EdgeInsetsGeometry? contentPadding;
  final double tileRadius;
  final TextStyle? titleStyle;
  final TextStyle? subtitleStyle;
  final int coverImageSize;
  static const double _gridFooterHeight = 48;

  const ArtistCard.list({
    super.key,
    required this.artist,
    this.onTap,
    this.subtitle,
    this.titleMaxLines = 1,
    this.coverSize = 56,
    this.contentPadding = const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
    this.tileRadius = 14,
    this.titleStyle,
    this.subtitleStyle,
    this.coverImageSize = 240,
  }) : layout = ArtistCardLayout.list;

  const ArtistCard.grid({
    super.key,
    required this.artist,
    this.onTap,
    this.subtitle,
    this.titleMaxLines = 1,
    this.coverSize = 96,
    this.titleStyle,
    this.subtitleStyle,
    this.coverImageSize = 260,
  })  : layout = ArtistCardLayout.grid,
        contentPadding = null,
        tileRadius = 0;

  @override
  State<ArtistCard> createState() => _ArtistCardState();
}

class _ArtistCardState extends State<ArtistCard> {
  bool _isHovering = false;

  void _setHover(bool hovering) {
    if (_isHovering == hovering) return;
    setState(() => _isHovering = hovering);
  }

  @override
  Widget build(BuildContext context) {
    return widget.layout == ArtistCardLayout.list
        ? _buildList(context)
        : _buildGrid(context);
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
              SizedBox(
                width: widget.coverSize,
                height: widget.coverSize,
                child: ClipOval(
                  child: CoverImage(
                    url: widget.artist.pic,
                    width: widget.coverSize,
                    height: widget.coverSize,
                    borderRadius: 0,
                    showShadow: false,
                    size: widget.coverImageSize,
                  ),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      widget.artist.name,
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

  Widget _buildGrid(BuildContext context) {
    final theme = Theme.of(context);
    final style = resolveMediaCardStyle(context, showShadow: true);
    final resolvedTitleStyle = widget.titleStyle ??
        TextStyle(
          color: theme.colorScheme.onSurface,
          fontSize: 13,
          fontWeight: AppTheme.fontWeightBold,
        );
    final resolvedSubtitleStyle = widget.subtitleStyle ??
        TextStyle(
          color: theme.colorScheme.onSurfaceVariant,
          fontSize: 11,
          fontWeight: AppTheme.fontWeightSemiBold,
        );
    final subtitleText = widget.subtitle ?? _defaultSubtitle();

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
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: style.backgroundColor,
              borderRadius: BorderRadius.circular(20),
              boxShadow: style.shadows,
            ),
            child: LayoutBuilder(
              builder: (context, constraints) {
                final coverHeight =
                    (constraints.maxHeight - ArtistCard._gridFooterHeight)
                        .clamp(0.0, constraints.maxHeight);
                return Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    SizedBox(
                      height: coverHeight,
                      child: Center(
                        child: ClipOval(
                          child: CoverImage(
                            url: widget.artist.pic,
                            width: widget.coverSize,
                            height: widget.coverSize,
                            borderRadius: 0,
                            showShadow: false,
                            size: widget.coverImageSize,
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(height: 6),
                    Text(
                      widget.artist.name,
                      maxLines: widget.titleMaxLines,
                      overflow: TextOverflow.ellipsis,
                      style: resolvedTitleStyle,
                    ),
                    if (subtitleText != null)
                      Text(
                        subtitleText,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: resolvedSubtitleStyle,
                      ),
                  ],
                );
              },
            ),
          ),
        ),
      ),
    );
  }

  String _defaultSubtitle() {
    final parts = <String>[];
    if (widget.artist.songCount > 0) {
      parts.add('${widget.artist.songCount} 首歌曲');
    }
    if (widget.artist.albumCount > 0) {
      parts.add('${widget.artist.albumCount} 张专辑');
    }
    if (widget.artist.fansCount > 0) {
      parts.add('${_formatCount(widget.artist.fansCount)} 粉丝');
    }
    return parts.join(' • ');
  }

  String _formatCount(int count) {
    if (count < 10000) return count.toString();
    return '${(count / 10000).toStringAsFixed(1)}万';
  }
}
