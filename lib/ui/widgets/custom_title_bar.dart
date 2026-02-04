import 'package:flutter/material.dart';
import 'package:bitsdojo_window/bitsdojo_window.dart';

class CustomTitleBar extends StatelessWidget {
  const CustomTitleBar({super.key});

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;

    return WindowTitleBarBox(
      child: Container(
        height: 52,
        color: Colors.transparent,
        child: Row(
          children: [
            // Left area: Reserved for traffic lights on macOS or padding
            const SizedBox(width: 80),
            
            // Middle Spacer / Move Window
            Expanded(child: MoveWindow()),
            
            // Right area: Native-looking window buttons
            WindowButtons(isDark: isDark),
          ],
        ),
      ),
    );
  }
}

class WindowButtons extends StatelessWidget {
  final bool isDark;
  const WindowButtons({super.key, required this.isDark});

  @override
  Widget build(BuildContext context) {
    final buttonColors = WindowButtonColors(
        iconNormal: isDark ? Colors.white54 : Colors.black54,
        mouseOver: isDark ? Colors.white10 : Colors.black12,
        mouseDown: isDark ? Colors.white24 : Colors.black26,
        iconMouseOver: isDark ? Colors.white : Colors.black,
        iconMouseDown: isDark ? Colors.white : Colors.black);

    final closeButtonColors = WindowButtonColors(
        mouseOver: const Color(0xFFD32F2F),
        mouseDown: const Color(0xFFB71C1C),
        iconNormal: isDark ? Colors.white54 : Colors.black54,
        iconMouseOver: Colors.white);

    return Row(
      children: [
        MinimizeWindowButton(colors: buttonColors),
        MaximizeWindowButton(colors: buttonColors),
        CloseWindowButton(colors: closeButtonColors),
      ],
    );
  }
}