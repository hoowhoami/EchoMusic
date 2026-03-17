import 'package:flutter/material.dart';
import 'package:window_manager/window_manager.dart';

class WindowsCaptionControls extends StatefulWidget {
  final Brightness? brightness;

  const WindowsCaptionControls({super.key, this.brightness});

  static const double buttonWidth = 46;
  static const double height = 32;
  static const double width = buttonWidth * 3;
  static const double iconSize = 10;

  @override
  State<WindowsCaptionControls> createState() =>
      _WindowsCaptionControlsState();
}

class _WindowsCaptionControlsState extends State<WindowsCaptionControls>
    with WindowListener {
  bool _isMaximized = false;
  bool _isFocused = true;

  @override
  void initState() {
    super.initState();
    windowManager.addListener(this);
    _syncWindowState();
  }

  Future<void> _syncWindowState() async {
    final isMaximized = await windowManager.isMaximized();
    final isFocused = await windowManager.isFocused();
    if (!mounted) return;
    setState(() {
      _isMaximized = isMaximized;
      _isFocused = isFocused;
    });
  }

  @override
  void dispose() {
    windowManager.removeListener(this);
    super.dispose();
  }

  @override
  void onWindowMaximize() {
    setState(() => _isMaximized = true);
  }

  @override
  void onWindowUnmaximize() {
    setState(() => _isMaximized = false);
  }

  @override
  void onWindowFocus() {
    setState(() => _isFocused = true);
  }

  @override
  void onWindowBlur() {
    setState(() => _isFocused = false);
  }

  @override
  Widget build(BuildContext context) {
    final brightness = widget.brightness ?? Theme.of(context).brightness;

    return SizedBox(
      width: WindowsCaptionControls.width,
      height: WindowsCaptionControls.height,
      child: Row(
        children: [
          _WindowsCaptionButton(
            type: _WindowsCaptionButtonType.minimize,
            brightness: brightness,
            isFocused: _isFocused,
            onPressed: () => windowManager.minimize(),
          ),
          _WindowsCaptionButton(
            type: _isMaximized
                ? _WindowsCaptionButtonType.restore
                : _WindowsCaptionButtonType.maximize,
            brightness: brightness,
            isFocused: _isFocused,
            onPressed: _isMaximized
                ? () => windowManager.unmaximize()
                : () => windowManager.maximize(),
          ),
          _WindowsCaptionButton(
            type: _WindowsCaptionButtonType.close,
            brightness: brightness,
            isFocused: _isFocused,
            onPressed: () => windowManager.close(),
          ),
        ],
      ),
    );
  }
}

enum _WindowsCaptionButtonType { minimize, maximize, restore, close }

class _WindowsCaptionButton extends StatefulWidget {
  const _WindowsCaptionButton({
    required this.type,
    required this.brightness,
    required this.isFocused,
    required this.onPressed,
  });

  final _WindowsCaptionButtonType type;
  final Brightness brightness;
  final bool isFocused;
  final VoidCallback onPressed;

  @override
  State<_WindowsCaptionButton> createState() => _WindowsCaptionButtonState();
}

class _WindowsCaptionButtonState extends State<_WindowsCaptionButton> {
  bool _isHovered = false;
  bool _isPressed = false;

  void _setHovered(bool hovered) {
    if (_isHovered == hovered) return;
    setState(() => _isHovered = hovered);
  }

  void _setPressed(bool pressed) {
    if (_isPressed == pressed) return;
    setState(() => _isPressed = pressed);
  }

  @override
  Widget build(BuildContext context) {
    final bool isDark = widget.brightness == Brightness.dark;
    final bool isClose = widget.type == _WindowsCaptionButtonType.close;
    
    Color baseIconColor;
    if (isDark) {
      baseIconColor = widget.isFocused 
          ? Colors.white 
          : Colors.white.withAlpha(120);
    } else {
      baseIconColor = widget.isFocused 
          ? Colors.black.withAlpha(230) 
          : Colors.black.withAlpha(90);
    }

    final Color hoverIconColor = isClose ? Colors.white : baseIconColor;
    final Color pressedIconColor = isClose
        ? Colors.white.withAlpha(210)
        : baseIconColor.withAlpha(isDark ? 190 : 180);

    final Color hoverBgColor = isClose
        ? const Color(0xffC42B1C)
        : isDark
            ? Colors.white.withAlpha(22)
            : Colors.black.withAlpha(22);
    final Color pressedBgColor = isClose
        ? const Color(0xffB2241A)
        : isDark
            ? Colors.white.withAlpha(36)
            : Colors.black.withAlpha(36);

    Color bgColor = Colors.transparent;
    Color iconColor = baseIconColor;
    if (_isHovered) {
      bgColor = hoverBgColor;
      iconColor = hoverIconColor;
    }
    if (_isPressed) {
      bgColor = pressedBgColor;
      iconColor = pressedIconColor;
    }

    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => _setHovered(true),
      onExit: (_) => _setHovered(false),
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTapDown: (_) => _setPressed(true),
        onTapCancel: () => _setPressed(false),
        onTapUp: (_) => _setPressed(false),
        onTap: widget.onPressed,
        child: Container(
          width: WindowsCaptionControls.buttonWidth,
          height: WindowsCaptionControls.height,
          color: bgColor,
          alignment: Alignment.center,
          child: CustomPaint(
            size: const Size(
              WindowsCaptionControls.iconSize,
              WindowsCaptionControls.iconSize,
            ),
            painter: _WindowsCaptionIconPainter(
              type: widget.type,
              color: iconColor,
            ),
          ),
        ),
      ),
    );
  }
}

class _WindowsCaptionIconPainter extends CustomPainter {
  _WindowsCaptionIconPainter({required this.type, required this.color});

  final _WindowsCaptionButtonType type;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final Paint paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.1
      ..strokeCap = StrokeCap.square;

    final double inset = size.width / 6;
    final double right = size.width - inset;
    final double bottom = size.height - inset;
    final double offset = size.width / 6;

    switch (type) {
      case _WindowsCaptionButtonType.minimize:
        canvas.drawLine(Offset(inset, bottom), Offset(right, bottom), paint);
        break;
      case _WindowsCaptionButtonType.maximize:
        canvas.drawRect(
          Rect.fromLTWH(inset, inset, right - inset, bottom - inset),
          paint,
        );
        break;
      case _WindowsCaptionButtonType.restore:
        final Rect backRect = Rect.fromLTWH(
          inset + offset,
          inset,
          right - inset - offset,
          bottom - inset - offset,
        );
        final Rect frontRect = Rect.fromLTWH(
          inset,
          inset + offset,
          right - inset - offset,
          bottom - inset - offset,
        );
        canvas.drawRect(backRect, paint);
        canvas.drawRect(frontRect, paint);
        break;
      case _WindowsCaptionButtonType.close:
        canvas.drawLine(Offset(inset, inset), Offset(right, bottom), paint);
        canvas.drawLine(Offset(right, inset), Offset(inset, bottom), paint);
        break;
    }
  }

  @override
  bool shouldRepaint(covariant _WindowsCaptionIconPainter oldDelegate) {
    return oldDelegate.type != type || oldDelegate.color != color;
  }
}
