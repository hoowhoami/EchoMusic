import 'package:flutter/material.dart';
import 'package:cached_network_image/cached_network_image.dart';

class CoverImage extends StatelessWidget {
  final String? url;
  final double? width;
  final double? height;
  final double borderRadius;
  final BoxFit fit;
  final int size;
  final bool showShadow;
  final Widget? placeholder;
  final Widget? errorWidget;

  const CoverImage({
    super.key,
    required this.url,
    this.width,
    this.height,
    this.borderRadius = 12,
    this.fit = BoxFit.cover,
    this.size = 400,
    this.showShadow = true,
    this.placeholder,
    this.errorWidget,
  });

  static String getCoverUrl(String? url, {int size = 400}) {
    if (url == null || url.isEmpty) {
      return 'https://imge.kugou.com/soft/collection/default.jpg';
    }
    String cover = url.replaceFirst('http://', 'https://');
    return cover
        .replaceAll('{size}', size.toString())
        .replaceFirst('c1.kgimg.com', 'imge.kugou.com');
  }

  @override
  Widget build(BuildContext context) {
    final coverUrl = getCoverUrl(url, size: size);
    final theme = Theme.of(context);
    
    // Calculate cache size based on display size to save CPU/Memory
    final cacheWidth = width != null && width! > 0 && width!.isFinite ? (width! * 2).toInt() : null;
    final cacheHeight = height != null && height! > 0 && height!.isFinite ? (height! * 2).toInt() : null;

    return RepaintBoundary(
      child: ClipRRect(
        borderRadius: BorderRadius.circular(borderRadius),
        child: CachedNetworkImage(
          imageUrl: coverUrl,
          width: width,
          height: height,
          fit: fit,
          memCacheWidth: cacheWidth,
          memCacheHeight: cacheHeight,
          placeholder: (context, url) =>
              placeholder ??
              Container(
                width: width,
                height: height,
                color: theme.colorScheme.onSurface.withAlpha(10),
                child: Center(
                  child: Icon(
                    Icons.music_note_rounded,
                    size: (width != null && width!.isFinite) ? width! * 0.4 : 24,
                    color: theme.colorScheme.onSurface.withAlpha(20),
                  ),
                ),
              ),
          errorWidget: (context, url, error) =>
              errorWidget ??
              Container(
                width: width,
                height: height,
                color: theme.colorScheme.onSurface.withAlpha(10),
                child: Icon(
                  Icons.music_note_rounded,
                  size: (width != null && width!.isFinite) ? width! * 0.5 : 40,
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
        ),
      ),
    );
  }
}
