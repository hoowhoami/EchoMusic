import 'package:flutter/material.dart';
import '../../models/playlist.dart';
import 'cover_image.dart';
import 'media_card_style.dart';

enum PlaylistCardLayout { grid, list }

class PlaylistCard extends StatefulWidget {
  final Playlist playlist;
  final PlaylistCardLayout layout;
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

  const PlaylistCard.grid({
    super.key,
    required this.playlist,
    this.onTap,
    this.subtitle,
    this.titleMaxLines = 2,
    this.coverRadius = 14,
    this.showShadow = true,
    this.titleStyle,
    this.subtitleStyle,
    this.coverImageSize = 300,
  })  : layout = PlaylistCardLayout.grid,
        coverSize = 0,
        contentPadding = null,
        tileRadius = 0;

  const PlaylistCard.list({
    super.key,
    required this.playlist,
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
  })  : layout = PlaylistCardLayout.list,
        showShadow = false;

  @override
  State<PlaylistCard> createState() => _PlaylistCardState();
}

class _PlaylistCardState extends State<PlaylistCard> {
  bool _isHovering = false;

  void _setHover(bool hovering) {
    if (_isHovering == hovering) return;
    setState(() => _isHovering = hovering);
  }

  @override
  Widget build(BuildContext context) {
    return widget.layout == PlaylistCardLayout.list
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
          fontWeight: FontWeight.w700,
          height: 1.1,
        );
    final resolvedSubtitleStyle = widget.subtitleStyle ??
        theme.textTheme.bodySmall?.copyWith(
          fontWeight: FontWeight.w600,
          color: theme.colorScheme.onSurfaceVariant,
        );

    return MouseRegion(
      onEnter: (_) => _setHover(true),
      onExit: (_) => _setHover(false),
      child: GestureDetector(
        onTap: widget.onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 160),
          curve: Curves.easeOutCubic,
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(
            color: style.backgroundColor,
            borderRadius: BorderRadius.circular(widget.coverRadius + 6),
            boxShadow: style.shadows,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(widget.coverRadius),
                  child: Stack(
                    fit: StackFit.expand,
                    children: [
                      CoverImage(
                        url: widget.playlist.pic,
                        fit: BoxFit.cover,
                        borderRadius: widget.coverRadius,
                        showShadow: false,
                        size: widget.coverImageSize,
                      ),
                      if (_isHovering)
                        Container(color: style.hoverOverlayStrong),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 10),
              Text(
                widget.playlist.name,
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
          fontWeight: FontWeight.w700,
        );
    final resolvedSubtitleStyle = widget.subtitleStyle ??
        theme.textTheme.bodySmall?.copyWith(
          fontWeight: FontWeight.w600,
          color: theme.colorScheme.onSurfaceVariant,
        );

    return MouseRegion(
      onEnter: (_) => _setHover(true),
      onExit: (_) => _setHover(false),
      child: GestureDetector(
        onTap: widget.onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 160),
          curve: Curves.easeOutCubic,
          padding: widget.contentPadding,
          decoration: BoxDecoration(
            color: style.backgroundColor,
            borderRadius: BorderRadius.circular(widget.tileRadius),
            boxShadow: const <BoxShadow>[],
          ),
          child: Row(
            children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(widget.coverRadius),
                child: Stack(
                  children: [
                    CoverImage(
                      url: widget.playlist.pic,
                      width: widget.coverSize,
                      height: widget.coverSize,
                      borderRadius: widget.coverRadius,
                      showShadow: false,
                      size: widget.coverImageSize,
                    ),
                    if (_isHovering)
                      Positioned.fill(
                        child: Container(color: style.hoverOverlayColor),
                      ),
                  ],
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      widget.playlist.name,
                      maxLines: widget.titleMaxLines,
                      overflow: TextOverflow.ellipsis,
                      style: resolvedTitleStyle,
                    ),
                    if (widget.subtitle != null) ...[
                      const SizedBox(height: 4),
                      Text(
                        widget.subtitle!,
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
}
