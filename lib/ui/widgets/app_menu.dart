import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../../providers/navigation_provider.dart';
import '../../theme/app_theme.dart';

typedef AppMenuContentBuilder<T> = Widget Function(
  BuildContext context,
  void Function([T? result]) close,
);

VoidCallback? _dismissActiveContextMenu;

enum AppMenuArrowEdge { top, bottom }

class AppDropdownAnchor<T> extends StatefulWidget {
  final Widget Function(BuildContext context, VoidCallback toggle, bool isOpen)
      builder;
  final AppMenuContentBuilder<T> menuBuilder;
  final double? width;
  final double? height;
  final BoxConstraints? constraints;
  final EdgeInsetsGeometry padding;
  final Alignment targetAnchor;
  final Alignment followerAnchor;
  final Offset offset;
  final bool showArrow;
  final AppMenuArrowEdge arrowEdge;
  final double arrowAlignment;
  final BorderRadius borderRadius;

  const AppDropdownAnchor({
    super.key,
    required this.builder,
    required this.menuBuilder,
    this.width,
    this.height,
    this.constraints,
    this.padding = const EdgeInsets.all(8),
    this.targetAnchor = Alignment.bottomLeft,
    this.followerAnchor = Alignment.topLeft,
    this.offset = const Offset(0, 8),
    this.showArrow = false,
    this.arrowEdge = AppMenuArrowEdge.top,
    this.arrowAlignment = 0.5,
    this.borderRadius = const BorderRadius.all(Radius.circular(20)),
  });

  @override
  State<AppDropdownAnchor<T>> createState() => _AppDropdownAnchorState<T>();
}

class _AppDropdownAnchorState<T> extends State<AppDropdownAnchor<T>> {
  final LayerLink _layerLink = LayerLink();
  final OverlayPortalController _controller = OverlayPortalController();
  final Object _tapRegionGroupId = Object();
  bool _isOpen = false;

  void _toggleMenu() {
    if (_isOpen) {
      _closeMenu();
      return;
    }
    setState(() => _isOpen = true);
    _controller.show();
  }

  void _closeMenu([T? _]) {
    if (!_isOpen) return;
    _controller.hide();
    if (mounted) setState(() => _isOpen = false);
  }

  @override
  void dispose() {
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return TapRegion(
      groupId: _tapRegionGroupId,
      onTapOutside: (_) => _closeMenu(),
      child: OverlayPortal(
        controller: _controller,
        overlayChildBuilder: (context) {
          return TapRegion(
            groupId: _tapRegionGroupId,
            onTapOutside: (_) => _closeMenu(),
            child: CompositedTransformFollower(
              link: _layerLink,
              showWhenUnlinked: false,
              targetAnchor: widget.targetAnchor,
              followerAnchor: widget.followerAnchor,
              offset: widget.offset,
              child: Material(
                color: Colors.transparent,
                child: AppMenuPanel(
                  width: widget.width,
                  height: widget.height,
                  constraints: widget.constraints,
                  padding: widget.padding,
                  borderRadius: widget.borderRadius,
                  showArrow: widget.showArrow,
                  arrowEdge: widget.arrowEdge,
                  arrowAlignment: widget.arrowAlignment,
                  child: Builder(
                    builder: (context) => widget.menuBuilder(context, _closeMenu),
                  ),
                ),
              ),
            ),
          );
        },
        child: CompositedTransformTarget(
          link: _layerLink,
          child: widget.builder(context, _toggleMenu, _isOpen),
        ),
      ),
    );
  }
}

class PlayerMenuAnchor<T> extends StatefulWidget {
  final Widget Function(BuildContext context, VoidCallback toggle, bool isOpen)
      builder;
  final AppMenuContentBuilder<T> menuBuilder;
  final double? width;
  final double? height;
  final BoxConstraints? constraints;
  final EdgeInsetsGeometry padding;
  final Alignment targetAnchor;
  final Alignment followerAnchor;
  final Offset offset;
  final bool showArrow;
  final AppMenuArrowEdge arrowEdge;
  final double arrowAlignment;
  final BorderRadius borderRadius;
  final EdgeInsets screenPadding;
  final double estimatedHeight;

  const PlayerMenuAnchor({
    super.key,
    required this.builder,
    required this.menuBuilder,
    this.width,
    this.height,
    this.constraints,
    this.padding = const EdgeInsets.all(8),
    this.targetAnchor = Alignment.bottomLeft,
    this.followerAnchor = Alignment.topLeft,
    this.offset = const Offset(0, 8),
    this.showArrow = false,
    this.arrowEdge = AppMenuArrowEdge.top,
    this.arrowAlignment = 0.5,
    this.borderRadius = const BorderRadius.all(Radius.circular(20)),
    this.screenPadding = const EdgeInsets.all(12),
    this.estimatedHeight = 280,
  });

  @override
  State<PlayerMenuAnchor<T>> createState() => _PlayerMenuAnchorState<T>();
}

class _PlayerMenuAnchorState<T> extends State<PlayerMenuAnchor<T>> {
  final GlobalKey _targetKey = GlobalKey();
  final OverlayPortalController _controller = OverlayPortalController();
  final Object _tapRegionGroupId = Object();
  bool _isOpen = false;

  void _toggleMenu() {
    if (_isOpen) {
      _closeMenu();
      return;
    }
    setState(() => _isOpen = true);
    _controller.show();
  }

  void _closeMenu([T? _]) {
    if (!_isOpen) return;
    _controller.hide();
    if (mounted) setState(() => _isOpen = false);
  }

  @override
  void dispose() {
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return TapRegion(
      groupId: _tapRegionGroupId,
      onTapOutside: (_) => _closeMenu(),
      child: OverlayPortal(
        controller: _controller,
        overlayChildBuilder: (context) {
          final overlay = Overlay.of(context);
          final overlayBox = overlay.context.findRenderObject() as RenderBox;
          final anchorContext = _targetKey.currentContext;
          if (anchorContext == null) {
            WidgetsBinding.instance.addPostFrameCallback((_) => _closeMenu());
            return const SizedBox.shrink();
          }
          final targetObject = anchorContext.findRenderObject();
          if (targetObject is! RenderBox || !targetObject.attached) {
            WidgetsBinding.instance.addPostFrameCallback((_) => _closeMenu());
            return const SizedBox.shrink();
          }
          final targetBox = targetObject;
          final targetOffset = targetBox.localToGlobal(
            Offset.zero,
            ancestor: overlayBox,
          );
          final targetRect = targetOffset & targetBox.size;
          final overlaySize = overlayBox.size;
          final placement = _resolvePlacement(targetRect, overlaySize);

          return Stack(
            children: [
              Positioned(
                left: placement.left,
                top: placement.top,
                width: placement.width,
                child: TapRegion(
                  groupId: _tapRegionGroupId,
                  onTapOutside: (_) => _closeMenu(),
                  child: Material(
                    color: Colors.transparent,
                    child: AppMenuPanel(
                      width: placement.width,
                      height: placement.height,
                      constraints: placement.constraints,
                      padding: widget.padding,
                      borderRadius: widget.borderRadius,
                      showArrow: widget.showArrow,
                      arrowEdge: placement.arrowEdge,
                      arrowAlignment: placement.arrowAlignment,
                      child: Builder(
                        builder: (context) => widget.menuBuilder(context, _closeMenu),
                      ),
                    ),
                  ),
                ),
              ),
            ],
          );
        },
        child: Container(
          key: _targetKey,
          child: widget.builder(context, _toggleMenu, _isOpen),
        ),
      ),
    );
  }

  _ResolvedAppMenuPlacement _resolvePlacement(Rect targetRect, Size overlaySize) {
    final usableRect = Rect.fromLTWH(
      widget.screenPadding.left,
      widget.screenPadding.top,
      math.max(0.0, overlaySize.width - widget.screenPadding.horizontal),
      math.max(0.0, overlaySize.height - widget.screenPadding.vertical),
    );
    final width = _preferredWidth(targetRect.width, usableRect.width);
    final preferredHeight = _preferredHeight();
    final arrowExtent = widget.showArrow ? 10.0 : 0.0;
    final desiredFootprintHeight = preferredHeight + arrowExtent;

    final preferred = _calculatePlacement(
      targetRect,
      width,
      desiredFootprintHeight,
      widget.targetAnchor,
      widget.followerAnchor,
      widget.offset,
      widget.arrowEdge,
      usableRect,
    );

    final flipped = _calculatePlacement(
      targetRect,
      width,
      desiredFootprintHeight,
      Alignment(widget.targetAnchor.x, -widget.targetAnchor.y),
      Alignment(widget.followerAnchor.x, -widget.followerAnchor.y),
      Offset(widget.offset.dx, -widget.offset.dy),
      widget.arrowEdge == AppMenuArrowEdge.top
          ? AppMenuArrowEdge.bottom
          : AppMenuArrowEdge.top,
      usableRect,
    );

    final chosen = flipped.visibleHeight > preferred.visibleHeight
        ? flipped
        : preferred;
    final maxHeight = math.max(0.0, chosen.footprintHeight - arrowExtent);

    return _ResolvedAppMenuPlacement(
      left: chosen.left,
      top: chosen.top,
      width: width,
      height: widget.height?.clamp(0.0, maxHeight),
      constraints: _resolveConstraints(width, maxHeight),
      arrowEdge: chosen.arrowEdge,
      arrowAlignment: _resolveArrowAlignment(targetRect, chosen.left, width),
    );
  }

  _CalculatedMenuPlacement _calculatePlacement(
    Rect targetRect,
    double width,
    double desiredFootprintHeight,
    Alignment targetAnchor,
    Alignment followerAnchor,
    Offset offset,
    AppMenuArrowEdge arrowEdge,
    Rect usableRect,
  ) {
    final targetPoint = _resolveRectAnchorPoint(targetRect, targetAnchor) + offset;
    final maxFootprintHeight = _resolveMaxFootprintHeight(
      targetPoint.dy,
      followerAnchor.y,
      usableRect,
    );
    final footprintHeight = desiredFootprintHeight.clamp(0.0, maxFootprintHeight);
    final topLeft = _calculateFollowerTopLeft(
      targetRect,
      Size(width, footprintHeight),
      targetAnchor,
      followerAnchor,
      offset,
    );
    final maxLeft = math.max(usableRect.left, usableRect.right - width);
    final left = topLeft.dx.clamp(usableRect.left, maxLeft);
    final maxTop = math.max(usableRect.top, usableRect.bottom - footprintHeight);
    final top = topLeft.dy.clamp(usableRect.top, maxTop);

    return _CalculatedMenuPlacement(
      left: left,
      top: top,
      visibleHeight: footprintHeight,
      footprintHeight: footprintHeight,
      arrowEdge: arrowEdge,
    );
  }

  Offset _resolveRectAnchorPoint(Rect rect, Alignment anchor) {
    return rect.topLeft +
        Offset(
          (anchor.x + 1) * rect.width / 2,
          (anchor.y + 1) * rect.height / 2,
        );
  }

  double _resolveMaxFootprintHeight(
    double anchorY,
    double followerAnchorY,
    Rect usableRect,
  ) {
    final followerFactor = (followerAnchorY + 1) / 2;
    final trailingFactor = 1 - followerFactor;
    var maxHeight = usableRect.height;

    if (followerFactor > 0) {
      maxHeight = math.min(maxHeight, (anchorY - usableRect.top) / followerFactor);
    }
    if (trailingFactor > 0) {
      maxHeight = math.min(
        maxHeight,
        (usableRect.bottom - anchorY) / trailingFactor,
      );
    }

    return maxHeight.clamp(0.0, usableRect.height);
  }

  double _preferredWidth(double targetWidth, double maxWidth) {
    final preferred = widget.width ?? widget.constraints?.maxWidth ?? targetWidth;
    if (!preferred.isFinite) return maxWidth;
    return preferred.clamp(0.0, maxWidth);
  }

  double _preferredHeight() {
    final preferred = widget.height ?? widget.constraints?.maxHeight;
    if (preferred != null && preferred.isFinite) return preferred;
    return widget.estimatedHeight;
  }

  BoxConstraints _resolveConstraints(double width, double maxHeight) {
    final constraints = widget.constraints;
    if (constraints == null) {
      return BoxConstraints(maxWidth: width, maxHeight: maxHeight);
    }

    return BoxConstraints(
      minWidth: constraints.minWidth.clamp(0.0, width),
      maxWidth: constraints.maxWidth.clamp(0.0, width),
      minHeight: constraints.minHeight.clamp(0.0, maxHeight),
      maxHeight: constraints.maxHeight.clamp(0.0, maxHeight),
    );
  }

  double _resolveArrowAlignment(Rect targetRect, double left, double width) {
    final centerX = targetRect.center.dx;
    if (width <= 0) return widget.arrowAlignment;
    return ((centerX - left) / width).clamp(0.12, 0.88);
  }
}

class _ResolvedAppMenuPlacement {
  final double left;
  final double top;
  final double width;
  final double? height;
  final BoxConstraints constraints;
  final AppMenuArrowEdge arrowEdge;
  final double arrowAlignment;

  const _ResolvedAppMenuPlacement({
    required this.left,
    required this.top,
    required this.width,
    required this.height,
    required this.constraints,
    required this.arrowEdge,
    required this.arrowAlignment,
  });
}

class _CalculatedMenuPlacement {
  final double left;
  final double top;
  final double visibleHeight;
  final double footprintHeight;
  final AppMenuArrowEdge arrowEdge;

  const _CalculatedMenuPlacement({
    required this.left,
    required this.top,
    required this.visibleHeight,
    required this.footprintHeight,
    required this.arrowEdge,
  });
}

Offset _calculateFollowerTopLeft(
  Rect targetRect,
  Size followerSize,
  Alignment targetAnchor,
  Alignment followerAnchor,
  Offset offset,
) {
  final targetPoint = targetRect.topLeft +
      Offset(
        (targetAnchor.x + 1) * targetRect.width / 2,
        (targetAnchor.y + 1) * targetRect.height / 2,
      );
  final followerPoint = Offset(
    (followerAnchor.x + 1) * followerSize.width / 2,
    (followerAnchor.y + 1) * followerSize.height / 2,
  );
  return targetPoint - followerPoint + offset;
}

Future<T?> showAppContextMenu<T>(
  BuildContext context, {
  required AppMenuContentBuilder<T> menuBuilder,
  required double width,
  double estimatedHeight = 280,
  Offset? tapPosition,
  BuildContext? anchorContext,
  bool alignRightToAnchor = false,
  Offset anchorOffset = const Offset(0, 8),
  EdgeInsets screenPadding = const EdgeInsets.all(12),
  BorderRadius borderRadius = const BorderRadius.all(Radius.circular(20)),
}) {
  assert(tapPosition != null || anchorContext != null);

  final overlay = Overlay.of(context);
  final overlayBox = overlay.context.findRenderObject() as RenderBox;
  final completer = Completer<T?>();
  final focusNode = FocusNode(debugLabel: 'AppContextMenu');
  NavigationProvider? navigationProvider;
  try {
    navigationProvider = Provider.of<NavigationProvider>(context, listen: false);
  } on ProviderNotFoundException {
    navigationProvider = null;
  }
  final initialNavigationKey = navigationProvider?.currentRefreshKey;
  late final void Function([T? result]) close;
  late final VoidCallback dismissCurrentMenu;
  late final VoidCallback handleNavigationChange;

  late OverlayEntry entry;
  var isClosed = false;

  handleNavigationChange = () {
    if (navigationProvider?.currentRefreshKey != initialNavigationKey) {
      close();
    }
  };

  close = ([T? result]) {
    if (isClosed) return;
    isClosed = true;
    navigationProvider?.removeListener(handleNavigationChange);
    if (identical(_dismissActiveContextMenu, dismissCurrentMenu)) {
      _dismissActiveContextMenu = null;
    }
    entry.remove();
    focusNode.dispose();
    if (!completer.isCompleted) completer.complete(result);
  };

  dismissCurrentMenu = () => close();
  navigationProvider?.addListener(handleNavigationChange);

  entry = OverlayEntry(
    builder: (overlayContext) {
      final overlaySize = overlayBox.size;
      final resolvedWidth = width.clamp(
        0.0,
        overlaySize.width - screenPadding.horizontal,
      ).toDouble();
      final maxMenuHeight = (overlaySize.height - screenPadding.vertical).clamp(
        0.0,
        double.infinity,
      ).toDouble();
      final anchorRect = anchorContext == null
          ? null
          : _resolveContextMenuAnchorRect(overlayBox, anchorContext);
      if (anchorContext != null && anchorRect == null) {
        WidgetsBinding.instance.addPostFrameCallback((_) => close());
        return const SizedBox.shrink();
      }

      return Focus(
        focusNode: focusNode,
        autofocus: true,
        onKeyEvent: (_, event) {
          if (event is KeyDownEvent &&
              event.logicalKey == LogicalKeyboardKey.escape) {
            close();
            return KeyEventResult.handled;
          }
          return KeyEventResult.ignored;
        },
        child: Stack(
          children: [
            Positioned.fill(
              child: GestureDetector(
                behavior: HitTestBehavior.translucent,
                onTap: () => close(),
                onSecondaryTapDown: (_) => close(),
                child: const SizedBox.expand(),
              ),
            ),
            TapRegion(
              onTapOutside: (_) => close(),
              child: CustomSingleChildLayout(
                delegate: _AppContextMenuLayoutDelegate(
                  menuWidth: resolvedWidth,
                  tapPosition: tapPosition == null
                      ? null
                      : overlayBox.globalToLocal(tapPosition),
                  anchorRect: anchorRect,
                  alignRightToAnchor: alignRightToAnchor,
                  anchorOffset: anchorOffset,
                  screenPadding: screenPadding,
                ),
                child: Material(
                  color: Colors.transparent,
                  child: AppMenuPanel(
                    width: resolvedWidth,
                    constraints: BoxConstraints(
                      minWidth: resolvedWidth,
                      maxWidth: resolvedWidth,
                      maxHeight: maxMenuHeight,
                    ),
                    padding: const EdgeInsets.all(8),
                    borderRadius: borderRadius,
                    child: Builder(
                      builder: (menuContext) => menuBuilder(menuContext, close),
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      );
    },
  );

  _dismissActiveContextMenu?.call();
  _dismissActiveContextMenu = dismissCurrentMenu;
  overlay.insert(entry);
  WidgetsBinding.instance.addPostFrameCallback((_) {
    if (!isClosed && focusNode.canRequestFocus) {
      focusNode.requestFocus();
    }
  });
  return completer.future;
}

Rect? _resolveContextMenuAnchorRect(
  RenderBox overlayBox,
  BuildContext anchorContext,
) {
  final object = anchorContext.findRenderObject();
  if (object is! RenderBox || !object.attached) {
    return null;
  }
  final box = object;
  final offset = box.localToGlobal(Offset.zero, ancestor: overlayBox);
  return offset & box.size;
}

class _AppContextMenuLayoutDelegate extends SingleChildLayoutDelegate {
  final double menuWidth;
  final Offset? tapPosition;
  final Rect? anchorRect;
  final bool alignRightToAnchor;
  final Offset anchorOffset;
  final EdgeInsets screenPadding;

  const _AppContextMenuLayoutDelegate({
    required this.menuWidth,
    required this.tapPosition,
    required this.anchorRect,
    required this.alignRightToAnchor,
    required this.anchorOffset,
    required this.screenPadding,
  }) : assert(tapPosition != null || anchorRect != null);

  @override
  BoxConstraints getConstraintsForChild(BoxConstraints constraints) {
    final maxWidth = math.max(0.0, constraints.biggest.width - screenPadding.horizontal);
    final maxHeight = math.max(0.0, constraints.biggest.height - screenPadding.vertical);
    final width = menuWidth.clamp(0.0, maxWidth).toDouble();
    return BoxConstraints(
      minWidth: width,
      maxWidth: width,
      maxHeight: maxHeight,
    );
  }

  @override
  Offset getPositionForChild(Size size, Size childSize) {
    final usableRect = Rect.fromLTWH(
      screenPadding.left,
      screenPadding.top,
      math.max(0.0, size.width - screenPadding.horizontal),
      math.max(0.0, size.height - screenPadding.vertical),
    );

    final preferredTopLeft = tapPosition != null
        ? _resolveTapTopLeft(tapPosition!, childSize, usableRect)
        : _resolveAnchorTopLeft(anchorRect!, childSize, usableRect);

    final maxLeft = math.max(usableRect.left, usableRect.right - childSize.width);
    final maxTop = math.max(usableRect.top, usableRect.bottom - childSize.height);

    return Offset(
      preferredTopLeft.dx.clamp(usableRect.left, maxLeft),
      preferredTopLeft.dy.clamp(usableRect.top, maxTop),
    );
  }

  Offset _resolveTapTopLeft(Offset position, Size childSize, Rect usableRect) {
    final spaceRight = usableRect.right - position.dx;
    final spaceLeft = position.dx - usableRect.left;
    final spaceBelow = usableRect.bottom - position.dy;
    final spaceAbove = position.dy - usableRect.top;

    final openLeft = spaceRight < childSize.width && spaceLeft > spaceRight;
    final openAbove = spaceBelow < childSize.height && spaceAbove > spaceBelow;

    return Offset(
      openLeft ? position.dx - childSize.width : position.dx,
      openAbove ? position.dy - childSize.height : position.dy,
    );
  }

  Offset _resolveAnchorTopLeft(Rect anchorRect, Size childSize, Rect usableRect) {
    final belowY = anchorRect.bottom + anchorOffset.dy;
    final aboveY = anchorRect.top - childSize.height - anchorOffset.dy;
    final availableBelow = usableRect.bottom - anchorRect.bottom - anchorOffset.dy;
    final availableAbove = anchorRect.top - usableRect.top - anchorOffset.dy;
    final openAbove =
        availableBelow < childSize.height && availableAbove > availableBelow;

    return Offset(
      (alignRightToAnchor
              ? anchorRect.right - childSize.width
              : anchorRect.left) +
          anchorOffset.dx,
      openAbove ? aboveY : belowY,
    );
  }

  @override
  bool shouldRelayout(covariant _AppContextMenuLayoutDelegate oldDelegate) {
    return menuWidth != oldDelegate.menuWidth ||
        tapPosition != oldDelegate.tapPosition ||
        anchorRect != oldDelegate.anchorRect ||
        alignRightToAnchor != oldDelegate.alignRightToAnchor ||
        anchorOffset != oldDelegate.anchorOffset ||
        screenPadding != oldDelegate.screenPadding;
  }
}

class AppMenuPanel extends StatelessWidget {
  final Widget child;
  final double? width;
  final double? height;
  final BoxConstraints? constraints;
  final EdgeInsetsGeometry padding;
  final BorderRadius borderRadius;
  final bool showArrow;
  final AppMenuArrowEdge arrowEdge;
  final double arrowAlignment;

  const AppMenuPanel({
    super.key,
    required this.child,
    this.width,
    this.height,
    this.constraints,
    this.padding = const EdgeInsets.all(8),
    this.borderRadius = const BorderRadius.all(Radius.circular(20)),
    this.showArrow = false,
    this.arrowEdge = AppMenuArrowEdge.top,
    this.arrowAlignment = 0.5,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final modernTheme = theme.extension<AppModernTheme>();
    final backgroundColor =
        (modernTheme?.modalColor ?? theme.colorScheme.surface).withAlpha(255);
    final borderColor = theme.colorScheme.outlineVariant.withAlpha(120);
    final arrowInset = showArrow ? 10.0 : 0.0;
    final arrowX = (arrowAlignment.clamp(0.0, 1.0) * 2) - 1;

    return Stack(
      clipBehavior: Clip.none,
      children: [
        Padding(
          padding: EdgeInsets.only(
            top: showArrow && arrowEdge == AppMenuArrowEdge.top ? arrowInset : 0,
            bottom:
                showArrow && arrowEdge == AppMenuArrowEdge.bottom ? arrowInset : 0,
          ),
          child: Container(
            width: width,
            height: height,
            constraints: constraints,
            decoration: BoxDecoration(
              color: backgroundColor,
              borderRadius: borderRadius,
              border: Border.all(color: borderColor, width: 1),
              boxShadow: [
                BoxShadow(
                  color: Colors.black.withAlpha(28),
                  blurRadius: 24,
                  offset: const Offset(0, 12),
                ),
              ],
            ),
            child: ClipRRect(
              borderRadius: borderRadius,
              child: Padding(padding: padding, child: child),
            ),
          ),
        ),
        if (showArrow)
          Positioned(
            left: 0,
            right: 0,
            top: arrowEdge == AppMenuArrowEdge.top ? 0 : null,
            bottom: arrowEdge == AppMenuArrowEdge.bottom ? 0 : null,
            child: IgnorePointer(
              child: Align(
                alignment: Alignment(
                  arrowX,
                  arrowEdge == AppMenuArrowEdge.top ? -1 : 1,
                ),
                child: Transform.translate(
                  offset: Offset(
                    0,
                    arrowEdge == AppMenuArrowEdge.top ? -1 : 1,
                  ),
                  child: CustomPaint(
                    size: const Size(18, 10),
                    painter: _AppMenuArrowPainter(
                      color: backgroundColor,
                      borderColor: borderColor,
                      edge: arrowEdge,
                    ),
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }
}

class AppMenuItemButton extends StatelessWidget {
  final Widget title;
  final Widget? subtitle;
  final Widget? leading;
  final Widget? trailing;
  final VoidCallback? onPressed;
  final bool isSelected;
  final bool isDestructive;
  final bool showCheckmark;
  final EdgeInsetsGeometry padding;
  final Color? hoverColor;

  const AppMenuItemButton({
    super.key,
    required this.title,
    this.subtitle,
    this.leading,
    this.trailing,
    this.onPressed,
    this.isSelected = false,
    this.isDestructive = false,
    this.showCheckmark = true,
    this.padding = const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
    this.hoverColor,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final accentColor = isDestructive
        ? theme.colorScheme.error
        : theme.colorScheme.primary;
    final selectedColor = accentColor.withAlpha(18);
    final resolvedHoverColor =
        hoverColor ?? accentColor.withAlpha(isSelected ? 18 : 12);

    return Container(
      decoration: isSelected
          ? BoxDecoration(
              color: selectedColor,
              borderRadius: BorderRadius.circular(14),
            )
          : null,
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onPressed,
          borderRadius: BorderRadius.circular(14),
          hoverColor: resolvedHoverColor,
          child: Padding(
            padding: padding,
            child: Row(
              children: [
                if (leading != null) ...[
                  leading!,
                  const SizedBox(width: 10),
                ],
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      title,
                      if (subtitle != null) ...[
                        const SizedBox(height: 2),
                        subtitle!,
                      ],
                    ],
                  ),
                ),
                if (trailing != null)
                  trailing!
                else if (showCheckmark && isSelected)
                  Icon(
                    CupertinoIcons.checkmark_alt,
                    size: 16,
                    color: accentColor,
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class AppMenuSectionLabel extends StatelessWidget {
  final String title;

  const AppMenuSectionLabel(this.title, {super.key});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 6, 12, 8),
      child: Text(
        title,
        style: TextStyle(
          fontSize: 10,
          fontWeight: AppTheme.fontWeightSemiBold,
          color: Theme.of(context).colorScheme.onSurfaceVariant,
          letterSpacing: 1.1,
        ),
      ),
    );
  }
}

class AppMenuTrigger extends StatefulWidget {
  final String label;
  final VoidCallback? onPressed;
  final bool isOpen;
  final Color? textColor;
  final Widget? suffix;
  final bool showChevron;
  final EdgeInsetsGeometry padding;
  final BoxConstraints? constraints;

  const AppMenuTrigger({
    super.key,
    required this.label,
    required this.onPressed,
    required this.isOpen,
    this.textColor,
    this.suffix,
    this.showChevron = true,
    this.padding = const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
    this.constraints,
  });

  @override
  State<AppMenuTrigger> createState() => _AppMenuTriggerState();
}

class _AppMenuTriggerState extends State<AppMenuTrigger> {
  bool _isHovered = false;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isDisabled = widget.onPressed == null;
    final accentColor = theme.colorScheme.primary;
    final textColor = widget.textColor ?? theme.colorScheme.onSurface;

    return MouseRegion(
      cursor: isDisabled ? SystemMouseCursors.basic : SystemMouseCursors.click,
      onEnter: (_) => setState(() => _isHovered = true),
      onExit: (_) => setState(() => _isHovered = false),
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: widget.onPressed,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 160),
          curve: Curves.easeOut,
          constraints: widget.constraints,
          padding: widget.padding,
          decoration: BoxDecoration(
            color: widget.isOpen
                ? accentColor.withAlpha(16)
                : (_isHovered
                    ? theme.colorScheme.onSurface.withAlpha(24)
                    : theme.colorScheme.onSurface.withAlpha(14)),
            borderRadius: BorderRadius.circular(12),
            border: Border.all(
              color: widget.isOpen
                  ? accentColor.withAlpha(56)
                  : theme.colorScheme.onSurface.withAlpha(18),
            ),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Flexible(
                child: Text(
                  widget.label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    color: isDisabled
                        ? theme.disabledColor
                        : (widget.isOpen ? accentColor : textColor),
                    fontSize: 13,
                    fontWeight: AppTheme.fontWeightSemiBold,
                  ),
                ),
              ),
              if (widget.suffix != null) ...[
                const SizedBox(width: 6),
                widget.suffix!,
              ],
              if (widget.showChevron) ...[
                const SizedBox(width: 8),
                AnimatedRotation(
                  turns: widget.isOpen ? 0.5 : 0,
                  duration: const Duration(milliseconds: 180),
                  curve: Curves.easeOut,
                  child: Icon(
                    CupertinoIcons.chevron_down,
                    size: 12,
                    color: isDisabled
                        ? theme.disabledColor
                        : (widget.isOpen
                            ? accentColor
                            : theme.colorScheme.onSurfaceVariant),
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _AppMenuArrowPainter extends CustomPainter {
  final Color color;
  final Color borderColor;
  final AppMenuArrowEdge edge;

  const _AppMenuArrowPainter({
    required this.color,
    required this.borderColor,
    required this.edge,
  });

  @override
  void paint(Canvas canvas, Size size) {
    final fillPaint = Paint()
      ..color = color
      ..style = PaintingStyle.fill;
    final borderPaint = Paint()
      ..color = borderColor
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1;

    final path = Path();
    if (edge == AppMenuArrowEdge.top) {
      path
        ..moveTo(size.width / 2, 0)
        ..lineTo(0, size.height)
        ..lineTo(size.width, size.height)
        ..close();
    } else {
      path
        ..moveTo(0, 0)
        ..lineTo(size.width / 2, size.height)
        ..lineTo(size.width, 0)
        ..close();
    }

    canvas.drawPath(path, fillPaint);
    canvas.drawPath(path, borderPaint);
  }

  @override
  bool shouldRepaint(covariant _AppMenuArrowPainter oldDelegate) {
    return oldDelegate.color != color ||
        oldDelegate.borderColor != borderColor ||
        oldDelegate.edge != edge;
  }
}