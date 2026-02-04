import 'package:flutter/material.dart';

class AppTheme {
  // Modern Universal Colors
  static const primaryAccent = Color(0xFF6366F1); // Indigo-600
  static const secondaryAccent = Color(0xFFEC4899); // Pink-500
  
  static const darkBg = Color(0xFF0F172A); // Slate-900
  static const darkSurface = Color(0xFF1E293B); // Slate-800
  static const darkCard = Color(0xFF334155); // Slate-700

  static const lightBg = Color(0xFFF8FAFC); // Slate-50
  static const lightSurface = Color(0xFFFFFFFF);
  static const lightCard = Color(0xFFF1F5F9); // Slate-100

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
      ),
      appBarTheme: const AppBarTheme(
        backgroundColor: Colors.transparent,
        elevation: 0,
        centerTitle: true,
        titleTextStyle: TextStyle(color: Colors.black, fontSize: 16, fontWeight: FontWeight.w600),
      ),
      cardTheme: CardThemeData(
        color: lightSurface,
        elevation: 2,
        shadowColor: Colors.black.withAlpha(20),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      ),
      sliderTheme: SliderThemeData(
        activeTrackColor: primaryAccent,
        inactiveTrackColor: primaryAccent.withAlpha(30),
        thumbColor: primaryAccent,
        trackHeight: 4,
      ),
      dividerTheme: DividerThemeData(
        color: Colors.black.withAlpha(10),
        thickness: 1,
      ),
      textTheme: base.textTheme.apply(
        fontFamily: 'Inter', // Modern universal sans-serif
        bodyColor: const Color(0xFF0F172A), // Slate-900 equivalent
        displayColor: const Color(0xFF0F172A),
      ).copyWith(
        titleLarge: const TextStyle(fontWeight: FontWeight.w800, fontSize: 24, letterSpacing: -0.5),
        bodyLarge: const TextStyle(fontSize: 16, height: 1.5),
      ),
      extensions: [
        AppModernTheme(
          sidebarColor: const Color(0xFFFFFFFF).withAlpha(200),
          playerBarColor: const Color(0xFFFFFFFF).withAlpha(230),
          dividerColor: Colors.black.withAlpha(15),
          glassBlur: 25.0,
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
      ),
      appBarTheme: const AppBarTheme(
        backgroundColor: Colors.transparent,
        elevation: 0,
        centerTitle: true,
        titleTextStyle: TextStyle(color: Colors.white, fontSize: 16, fontWeight: FontWeight.w600),
      ),
      cardTheme: CardThemeData(
        color: darkSurface,
        elevation: 4,
        shadowColor: Colors.black.withAlpha(100),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
      ),
      sliderTheme: SliderThemeData(
        activeTrackColor: primaryAccent,
        inactiveTrackColor: Colors.white.withAlpha(20),
        thumbColor: Colors.white,
        trackHeight: 4,
      ),
      dividerTheme: DividerThemeData(
        color: Colors.white.withAlpha(10),
        thickness: 1,
      ),
      textTheme: base.textTheme.apply(
        fontFamily: 'Inter',
        bodyColor: const Color(0xFFF1F5F9), // Slate-100 equivalent
        displayColor: Colors.white,
      ).copyWith(
        titleLarge: const TextStyle(fontWeight: FontWeight.w800, fontSize: 24, letterSpacing: -0.5),
        bodyLarge: const TextStyle(fontSize: 16, height: 1.5),
      ),
      extensions: [
        AppModernTheme(
          sidebarColor: const Color(0xFF0F172A).withAlpha(180),
          playerBarColor: const Color(0xFF1E293B).withAlpha(210),
          dividerColor: Colors.white.withAlpha(10),
          glassBlur: 25.0,
        ),
      ],
    );
  }
}

class AppModernTheme extends ThemeExtension<AppModernTheme> {
  final Color? sidebarColor;
  final Color? playerBarColor;
  final Color? dividerColor;
  final double? glassBlur;

  AppModernTheme({
    this.sidebarColor,
    this.playerBarColor,
    this.dividerColor,
    this.glassBlur,
  });

  @override
  ThemeExtension<AppModernTheme> copyWith({
    Color? sidebarColor,
    Color? playerBarColor,
    Color? dividerColor,
    double? glassBlur,
  }) {
    return AppModernTheme(
      sidebarColor: sidebarColor ?? this.sidebarColor,
      playerBarColor: playerBarColor ?? this.playerBarColor,
      dividerColor: dividerColor ?? this.dividerColor,
      glassBlur: glassBlur ?? this.glassBlur,
    );
  }

  @override
  ThemeExtension<AppModernTheme> lerp(ThemeExtension<AppModernTheme>? other, double t) {
    if (other is! AppModernTheme) return this;
    return AppModernTheme(
      sidebarColor: Color.lerp(sidebarColor, other.sidebarColor, t),
      playerBarColor: Color.lerp(playerBarColor, other.playerBarColor, t),
      dividerColor: Color.lerp(dividerColor, other.dividerColor, t),
      glassBlur: _lerpDouble(glassBlur, other.glassBlur, t),
    );
  }

  static double? _lerpDouble(num? a, num? b, double t) {
    if (a == null && b == null) return null;
    a ??= 0.0;
    b ??= 0.0;
    return a + (b - a) * t;
  }
}
