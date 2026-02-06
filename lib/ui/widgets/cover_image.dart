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

    Widget image = ClipRRect(
      borderRadius: BorderRadius.circular(borderRadius),
      child: CachedNetworkImage(
        imageUrl: coverUrl,
        width: width,
        height: height,
        fit: fit,
        placeholder: (context, url) =>
            placeholder ??
            Container(
              width: width,
              height: height,
              color: theme.colorScheme.onSurface.withAlpha(10),
              child: const Center(
                child: SizedBox(
                  width: 24,
                  height: 24,
                  child: CircularProgressIndicator(strokeWidth: 2),
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
    );

    if (showShadow) {
      return Container(
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(borderRadius),
          boxShadow: [
            BoxShadow(
              color: theme.colorScheme.shadow.withAlpha(60),
              blurRadius: 20,
              offset: const Offset(0, 10),
              spreadRadius: -8,
            ),
          ],
        ),
        child: image,
      );
    }

    return image;
  }
}
