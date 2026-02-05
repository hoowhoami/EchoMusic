import 'package:flutter/material.dart';

class AppTheme {
  // Premium Blue - 类似 Apple Music 的高级蓝灰配色
  static const primaryAccent = Color(0xFF0071E3); // 高级蓝
  static const secondaryAccent = Color(0xFF5AC8FA); // 天空蓝
  static const successAccent = Color(0xFF34C759); // 清新绿

  static const darkBg = Color(0xFF0C0C0E); // 深邃黑
  static const darkSurface = Color(0xFF1C1C1E); // 深灰
  static const darkCard = Color(0xFF2C2C2E); // 柔和灰

  static const lightBg = Color(0xFFF5F5F7); // 浅灰白
  static const lightSurface = Color(0xFFFFFFFF);
  static const lightCard = Color(0xFFFFFFFF);

  static ThemeData light() {
    final base = ThemeData.light(useMaterial3: true);
    return base.copyWith(
      primaryColor: primaryAccent,
      scaffoldBackgroundColor: lightBg,
      colorScheme: ColorScheme.fromSeed(
        seedColor: primaryAccent,
        brightness: Brightness.light,
        primary: primaryAccent,
        secondary: secondaryAccent,
        surface: lightSurface,
        onSurface: const Color(0xFF1D1D1F), // Apple-style deep black
        onSurfaceVariant: const Color(0xFF4B5563), // Improved readability for secondary text
        surfaceContainerHighest: const Color(0xFFE5E7EB), // For backgrounds of elements
        outline: const Color(0xFFD1D5DB),
        outlineVariant: const Color(0xFFE5E7EB),
      ),
      appBarTheme: const AppBarTheme(
        backgroundColor: Colors.transparent,
        elevation: 0,
        centerTitle: true,
        titleTextStyle: TextStyle(color: Color(0xFF111827), fontSize: 16, fontWeight: FontWeight.bold),
        iconTheme: IconThemeData(color: Color(0xFF1D1D1F)),
      ),
      cardTheme: CardThemeData(
        color: lightSurface,
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12),
          side: const BorderSide(color: Color(0xFFE5E5EA), width: 1.0),
        ),
      ),
      sliderTheme: SliderThemeData(
        activeTrackColor: primaryAccent,
        inactiveTrackColor: primaryAccent.withAlpha(30),
        thumbColor: primaryAccent,
        overlayColor: primaryAccent.withAlpha(15),
        trackHeight: 3.0,
        thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 6),
      ),
      switchTheme: SwitchThemeData(
        thumbColor: WidgetStateProperty.resolveWith((states) {
          if (states.contains(WidgetState.selected)) {
            return primaryAccent;
          }
          return const Color(0xFFD1D5DB);
        }),
        trackColor: WidgetStateProperty.resolveWith((states) {
          if (states.contains(WidgetState.selected)) {
            return primaryAccent.withAlpha(80);
          }
          return const Color(0xFFE5E7EB);
        }),
        materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
      ),
      dividerTheme: const DividerThemeData(
        color: Color(0xFFE5E5EA),
        thickness: 0.8,
      ),
      textTheme: base.textTheme.apply(
        fontFamily: 'Inter',
        bodyColor: const Color(0xFF1D1D1F),
        displayColor: const Color(0xFF111827),
      ).copyWith(
        titleLarge: const TextStyle(fontWeight: FontWeight.w800, fontSize: 22, letterSpacing: -0.6),
        titleMedium: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15, letterSpacing: -0.3),
        bodyLarge: const TextStyle(fontSize: 14, height: 1.5, fontWeight: FontWeight.w500),
        bodyMedium: const TextStyle(fontSize: 13, height: 1.5, color: Color(0xFF4B5563)),
        bodySmall: const TextStyle(fontSize: 12, color: Color(0xFF6B7280)),
      ),
      extensions: [
        AppModernTheme(
          sidebarColor: const Color(0xFFFFFFFF).withAlpha(245),
          playerBarColor: const Color(0xFFFFFFFF).withAlpha(250),
          dividerColor: const Color(0xFFE5E5EA),
          sidebarBorder: const Color(0xFFE5E5EA),
          glassBlur: 25.0,
          cardHighlight: primaryAccent.withAlpha(8),
        ),
      ],
    );
  }

  static ThemeData dark() {
    final base = ThemeData.dark(useMaterial3: true);
    return base.copyWith(
      primaryColor: primaryAccent,
      scaffoldBackgroundColor: darkBg,
      colorScheme: ColorScheme.fromSeed(
        seedColor: primaryAccent,
        brightness: Brightness.dark,
        primary: primaryAccent,
        secondary: secondaryAccent,
        surface: darkSurface,
        onSurface: const Color(0xFFF5F5F7), // Improved readability
        onSurfaceVariant: const Color(0xFF9CA3AF),
        surfaceContainerHighest: const Color(0xFF2C2C2E),
        outline: const Color(0xFF38383A),
        outlineVariant: const Color(0xFF2C2C2E),
      ),
      appBarTheme: const AppBarTheme(
        backgroundColor: Colors.transparent,
        elevation: 0,
        centerTitle: true,
        titleTextStyle: TextStyle(color: Color(0xFFFFFFFF), fontSize: 16, fontWeight: FontWeight.bold),
        iconTheme: IconThemeData(color: Color(0xFFF5F5F7)),
      ),
      cardTheme: CardThemeData(
        color: darkSurface,
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12),
          side: const BorderSide(color: Color(0xFF38383A), width: 1.0),
        ),
      ),
      sliderTheme: SliderThemeData(
        activeTrackColor: primaryAccent,
        inactiveTrackColor: Colors.white.withAlpha(15),
        thumbColor: Colors.white,
        overlayColor: primaryAccent.withAlpha(30),
        trackHeight: 3.0,
        thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 6),
      ),
      dividerTheme: const DividerThemeData(
        color: Color(0xFF38383A),
        thickness: 0.8,
      ),
      textTheme: base.textTheme.apply(
        fontFamily: 'Inter',
        bodyColor: const Color(0xFFF5F5F7),
        displayColor: Colors.white,
      ).copyWith(
        titleLarge: const TextStyle(fontWeight: FontWeight.w800, fontSize: 22, letterSpacing: -0.6),
        titleMedium: const TextStyle(fontWeight: FontWeight.w700, fontSize: 15, letterSpacing: -0.3),
        bodyLarge: const TextStyle(fontSize: 14, height: 1.5, fontWeight: FontWeight.w500),
        bodyMedium: const TextStyle(fontSize: 13, height: 1.5, color: Color(0xFF9CA3AF)),
        bodySmall: const TextStyle(fontSize: 12, color: Color(0xFF6B7280)),
      ),
      extensions: [
        AppModernTheme(
          sidebarColor: const Color(0xFF0C0C0E).withAlpha(240),
          playerBarColor: const Color(0xFF1C1C1E).withAlpha(245),
          dividerColor: const Color(0xFF38383A),
          sidebarBorder: const Color(0xFF2C2C2E),
          glassBlur: 25.0,
          cardHighlight: primaryAccent.withAlpha(15),
        ),
      ],
    );
  }
}

class AppModernTheme extends ThemeExtension<AppModernTheme> {
  final Color? sidebarColor;
  final Color? playerBarColor;
  final Color? dividerColor;
  final Color? sidebarBorder;
  final double? glassBlur;
  final Color? cardHighlight;

  AppModernTheme({
    this.sidebarColor,
    this.playerBarColor,
    this.dividerColor,
    this.sidebarBorder,
    this.glassBlur,
    this.cardHighlight,
  });

  @override
  ThemeExtension<AppModernTheme> copyWith({
    Color? sidebarColor,
    Color? playerBarColor,
    Color? dividerColor,
    Color? sidebarBorder,
    double? glassBlur,
    Color? cardHighlight,
  }) {
    return AppModernTheme(
      sidebarColor: sidebarColor ?? this.sidebarColor,
      playerBarColor: playerBarColor ?? this.playerBarColor,
      dividerColor: dividerColor ?? this.dividerColor,
      sidebarBorder: sidebarBorder ?? this.sidebarBorder,
      glassBlur: glassBlur ?? this.glassBlur,
      cardHighlight: cardHighlight ?? this.cardHighlight,
    );
  }

  @override
  ThemeExtension<AppModernTheme> lerp(ThemeExtension<AppModernTheme>? other, double t) {
    if (other is! AppModernTheme) return this;
    return AppModernTheme(
      sidebarColor: Color.lerp(sidebarColor, other.sidebarColor, t),
      playerBarColor: Color.lerp(playerBarColor, other.playerBarColor, t),
      dividerColor: Color.lerp(dividerColor, other.dividerColor, t),
      sidebarBorder: Color.lerp(sidebarBorder, other.sidebarBorder, t),
      glassBlur: _lerpDouble(glassBlur, other.glassBlur, t),
      cardHighlight: Color.lerp(cardHighlight, other.cardHighlight, t),
    );
  }

  static double? _lerpDouble(num? a, num? b, double t) {
    if (a == null && b == null) return null;
    a ??= 0.0;
    b ??= 0.0;
    return a + (b - a) * t;
  }
}
