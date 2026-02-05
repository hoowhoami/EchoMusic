import 'package:flutter/material.dart';
import 'package:bitsdojo_window/bitsdojo_window.dart';

class CustomTitleBar extends StatelessWidget {
  const CustomTitleBar({super.key});

  @override
  Widget build(BuildContext context) {
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
            const WindowButtons(),
          ],
        ),
      ),
    );
  }
}

class WindowButtons extends StatelessWidget {
  const WindowButtons({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    
    final buttonColors = WindowButtonColors(
        iconNormal: theme.colorScheme.onSurfaceVariant,
        mouseOver: theme.colorScheme.onSurface.withAlpha(25),
        mouseDown: theme.colorScheme.onSurface.withAlpha(50),
        iconMouseOver: theme.colorScheme.onSurface,
        iconMouseDown: theme.colorScheme.onSurface);

    final closeButtonColors = WindowButtonColors(
        mouseOver: const Color(0xFFD32F2F),
        mouseDown: const Color(0xFFB71C1C),
        iconNormal: theme.colorScheme.onSurfaceVariant,
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