import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';

class BackToTop extends StatefulWidget {
  final ScrollController? controller;
  final VoidCallback? onPressed;
  final bool? show;
  final double threshold;
  final double right;
  final double bottom;

  const BackToTop({
    super.key,
    this.controller,
    this.onPressed,
    this.show,
    this.threshold = 300,
    this.right = 24,
    this.bottom = 24,
  }) : assert(controller != null || (show != null && onPressed != null), 
          'Either controller must be provided, or both show and onPressed must be provided');

  @override
  State<BackToTop> createState() => _BackToTopState();
}

class _BackToTopState extends State<BackToTop> {
  bool _internalShow = false;

  bool get _effectiveShow => widget.show ?? _internalShow;

  @override
  void initState() {
    super.initState();
    widget.controller?.addListener(_scrollListener);
  }

  @override
  void didUpdateWidget(BackToTop oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller) {
      oldWidget.controller?.removeListener(_scrollListener);
      widget.controller?.addListener(_scrollListener);
    }
  }

  @override
  void dispose() {
    widget.controller?.removeListener(_scrollListener);
    super.dispose();
  }

  void _scrollListener() {
    if (widget.controller == null || !widget.controller!.hasClients) return;
    
    if (widget.controller!.offset > widget.threshold && !_internalShow) {
      setState(() => _internalShow = true);
    } else if (widget.controller!.offset <= widget.threshold && _internalShow) {
      setState(() => _internalShow = false);
    }
  }

  void _scrollToTop() {
    if (widget.onPressed != null) {
      widget.onPressed!();
      return;
    }

    widget.controller?.animateTo(
      0,
      duration: const Duration(milliseconds: 500),
      curve: Curves.easeInOutCubic,
    );
  }

  @override
  Widget build(BuildContext context) {
    if (!_effectiveShow) return const SizedBox.shrink();

    return Positioned(
      right: widget.right,
      bottom: widget.bottom,
      child: _BackToTopButton(onPressed: _scrollToTop),
    );
  }
}

class _BackToTopButton extends StatelessWidget {
  final VoidCallback onPressed;

  const _BackToTopButton({required this.onPressed});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onPressed,
        borderRadius: BorderRadius.circular(16),
        child: Container(
          width: 48,
          height: 48,
          decoration: BoxDecoration(
            color: theme.colorScheme.surface.withAlpha(220),
            borderRadius: BorderRadius.circular(16),
            border: Border.all(
              color: theme.colorScheme.outlineVariant,
              width: 1,
            ),
            boxShadow: [
              BoxShadow(
                color: theme.colorScheme.shadow.withAlpha(20),
                blurRadius: 10,
                offset: const Offset(0, 4),
              ),
            ],
          ),
          child: Icon(
            CupertinoIcons.arrow_up,
            color: theme.colorScheme.onSurfaceVariant,
            size: 24,
          ),
        ),
      ),
    );
  }
}
