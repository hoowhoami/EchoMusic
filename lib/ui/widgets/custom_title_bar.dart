import 'package:flutter/material.dart';
import 'package:bitsdojo_window/bitsdojo_window.dart';
import 'package:provider/provider.dart';
import 'package:flutter/cupertino.dart';
import 'dart:ui';
import 'package:echomusic/providers/refresh_provider.dart';
import 'package:echomusic/theme/app_theme.dart';

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

                // Navigation Controls (Note: These need integration with HomeScreen state for full functionality)
                _NavButton(
                  icon: CupertinoIcons.chevron_left,
                  onPressed: () => Navigator.maybePop(context),
                  tooltip: '后退',
                ),
                _NavButton(
                  icon: CupertinoIcons.chevron_right,
                  onPressed: null, // Placeholder
                  tooltip: '前进',
                ),
                _NavButton(
                  icon: CupertinoIcons.refresh,
                  onPressed: () => context.read<RefreshProvider>().triggerRefresh(),
                  tooltip: '刷新',
                ),

                const SizedBox(width: 8),
                
                // Middle Spacer / Move Window
                Expanded(
                  child: MoveWindow(
                    child: Container(
                      alignment: Alignment.centerLeft,
                      padding: const EdgeInsets.only(left: 8),
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

class _NavButton extends StatelessWidget {
  final IconData icon;
  final VoidCallback? onPressed;
  final String tooltip;

  const _NavButton({
    required this.icon,
    this.onPressed,
    required this.tooltip,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Material(
      color: Colors.transparent,
      child: IconButton(
        onPressed: onPressed,
        icon: Icon(
          icon,
          size: 16,
          color: onPressed != null 
            ? theme.colorScheme.onSurface.withAlpha(120)
            : theme.colorScheme.onSurface.withAlpha(40),
        ),
        splashRadius: 20,
        tooltip: tooltip,
        constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
        padding: EdgeInsets.zero,
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