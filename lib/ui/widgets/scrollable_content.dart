import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';

/// 通用的可滚动内容容器，提供返回顶部功能
class ScrollableContent extends StatefulWidget {
  final Widget child;
  final EdgeInsetsGeometry padding;
  final bool showBackToTop;

  const ScrollableContent({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.symmetric(horizontal: 40, vertical: 32),
    this.showBackToTop = true,
  });

  @override
  State<ScrollableContent> createState() => _ScrollableContentState();
}

class _ScrollableContentState extends State<ScrollableContent> {
  final ScrollController _scrollController = ScrollController();
  bool _showBackToTopButton = false;

  @override
  void initState() {
    super.initState();
    if (widget.showBackToTop) {
      _scrollController.addListener(_scrollListener);
    }
  }

  @override
  void dispose() {
    if (widget.showBackToTop) {
      _scrollController.removeListener(_scrollListener);
    }
    _scrollController.dispose();
    super.dispose();
  }

  void _scrollListener() {
    if (_scrollController.offset > 300 && !_showBackToTopButton) {
      setState(() {
        _showBackToTopButton = true;
      });
    } else if (_scrollController.offset <= 300 && _showBackToTopButton) {
      setState(() {
        _showBackToTopButton = false;
      });
    }
  }

  void _scrollToTop() {
    _scrollController.animateTo(
      0,
      duration: const Duration(milliseconds: 500),
      curve: Curves.easeInOutCubic,
    );
  }

  @override
  Widget build(BuildContext context) {
    return Stack(
      children: [
        SingleChildScrollView(
          controller: _scrollController,
          physics: const BouncingScrollPhysics(),
          padding: widget.padding,
          child: widget.child,
        ),
        if (widget.showBackToTop && _showBackToTopButton)
          Positioned(
            right: 24,
            bottom: 24,
            child: _BackToTopButton(onPressed: _scrollToTop),
          ),
      ],
    );
  }
}

class _BackToTopButton extends StatelessWidget {
  final VoidCallback onPressed;

  const _BackToTopButton({required this.onPressed});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isDark = theme.brightness == Brightness.dark;

    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onPressed,
        borderRadius: BorderRadius.circular(16),
        child: Container(
          width: 48,
          height: 48,
          decoration: BoxDecoration(
            color: isDark
                ? Colors.white.withAlpha(10)
                : Colors.white.withAlpha(200),
            borderRadius: BorderRadius.circular(16),
            border: Border.all(
              color: isDark
                  ? Colors.white.withAlpha(10)
                  : Colors.white.withAlpha(30),
              width: 1,
            ),
            boxShadow: [
              BoxShadow(
                color: Colors.black.withAlpha(10),
                blurRadius: 10,
                offset: const Offset(0, 4),
              ),
            ],
          ),
          child: Icon(
            CupertinoIcons.arrow_up,
            color: isDark ? Colors.white70 : Colors.black54,
            size: 24,
          ),
        ),
      ),
    );
  }
}
