import 'package:flutter/material.dart';
import '../../theme/app_theme.dart';

class MediaCardStyle {
  final Color backgroundColor;
  final Color hoverOverlayColor;
  final Color hoverOverlayStrong;
  final Color hoverGlowColor;
  final List<BoxShadow> shadows;
  final List<BoxShadow> hoverShadows;
  final List<BoxShadow> focusShadows;

  const MediaCardStyle({
    required this.backgroundColor,
    required this.hoverOverlayColor,
    required this.hoverOverlayStrong,
    required this.hoverGlowColor,
    required this.shadows,
    required this.hoverShadows,
    required this.focusShadows,
  });
}

MediaCardStyle resolveMediaCardStyle(
  BuildContext context, {
  required bool showShadow,
}) {
  final theme = Theme.of(context);
  final modernTheme = theme.extension<AppModernTheme>();
  final baseColor = modernTheme?.modalColor ?? theme.colorScheme.surface;
  final hoverOverlayColor =
      modernTheme?.cardHighlight ?? theme.colorScheme.primary.withAlpha(10);
  final hoverOverlayStrong = theme.colorScheme.primary.withAlpha(18);
  final hoverGlowColor = theme.colorScheme.primary.withAlpha(36);
  final shadowBase = theme.brightness == Brightness.dark
      ? Colors.black.withAlpha(100)
      : Colors.black.withAlpha(16);
  final shadowHover = theme.brightness == Brightness.dark
      ? Colors.black.withAlpha(150)
      : Colors.black.withAlpha(26);
  final shadowFocus = theme.brightness == Brightness.dark
      ? Colors.black.withAlpha(180)
      : Colors.black.withAlpha(40);

  final shadows = showShadow
      ? [
          BoxShadow(
            color: shadowBase,
            blurRadius: 18,
            offset: const Offset(0, 8),
          ),
        ]
      : const <BoxShadow>[];
  final hoverShadows = showShadow
      ? [
          BoxShadow(
            color: shadowHover,
            blurRadius: 24,
            offset: const Offset(0, 10),
          ),
          BoxShadow(
            color: hoverGlowColor,
            blurRadius: 24,
            offset: const Offset(0, 0),
          ),
        ]
      : const <BoxShadow>[];
  final focusShadows = showShadow
      ? [
          BoxShadow(
            color: shadowFocus,
            blurRadius: 28,
            offset: const Offset(0, 12),
          ),
          BoxShadow(
            color: hoverGlowColor.withAlpha(60),
            blurRadius: 30,
            offset: const Offset(0, 0),
          ),
        ]
      : const <BoxShadow>[];

  return MediaCardStyle(
    backgroundColor: baseColor,
    hoverOverlayColor: hoverOverlayColor,
    hoverOverlayStrong: hoverOverlayStrong,
    hoverGlowColor: hoverGlowColor,
    shadows: shadows,
    hoverShadows: hoverShadows,
    focusShadows: focusShadows,
  );
}
