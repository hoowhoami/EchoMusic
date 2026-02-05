import 'package:flutter/material.dart';
import 'package:bitsdojo_window/bitsdojo_window.dart';
import 'dart:ui';
import '../../theme/app_theme.dart';

class CustomTitleBar extends StatelessWidget {
  const CustomTitleBar({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final modernTheme = theme.extension<AppModernTheme>()!;

    return WindowTitleBarBox(
      child: ClipRect(
        child: BackdropFilter(
          filter: ImageFilter.blur(
            sigmaX: modernTheme.glassBlur!,
            sigmaY: modernTheme.glassBlur!,
          ),
          child: Container(
            height: 52,
            decoration: BoxDecoration(
              color: modernTheme.titleBarColor,
              border: Border(
                bottom: BorderSide(
                  color: modernTheme.dividerColor!.withAlpha(40),
                  width: 0.5,
                ),
              ),
            ),
            child: Row(
              children: [
                // Left area: Reserved for traffic lights on macOS or padding
                const SizedBox(width: 80),
                
                // Middle Spacer / Move Window
                Expanded(
                  child: MoveWindow(
                    child: Container(
                      alignment: Alignment.centerLeft,
                      padding: const EdgeInsets.only(left: 16),
                      child: Text(
                        'EchoMusic',
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w700,
                          color: theme.colorScheme.onSurface.withAlpha(100),
                          letterSpacing: 0.5,
                        ),
                      ),
                    ),
                  ),
                ),
                
                // Right area: Native-looking window buttons
                const WindowButtons(),
              ],
            ),
          ),
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