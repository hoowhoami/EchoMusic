import 'package:flutter/material.dart';

class DetailPageSliverHeader extends StatelessWidget {
  static const double _collapseThreshold = 156;

  final String typeLabel;
  final String title;
  final Widget expandedCover;
  final Widget collapsedCover;
  final List<Widget> detailChildren;
  final Widget? actions;
  final double expandedHeight;

  const DetailPageSliverHeader({
    super.key,
    required this.typeLabel,
    required this.title,
    required this.expandedCover,
    required this.collapsedCover,
    this.detailChildren = const <Widget>[],
    this.actions,
    this.expandedHeight = 244,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return SliverAppBar(
      backgroundColor: theme.scaffoldBackgroundColor,
      surfaceTintColor: Colors.transparent,
      expandedHeight: expandedHeight,
      pinned: true,
      elevation: 0,
      automaticallyImplyLeading: false,
      flexibleSpace: LayoutBuilder(
        builder: (context, constraints) {
          final isCollapsed = constraints.maxHeight <= _collapseThreshold;

          return ClipRect(
            child: AnimatedSwitcher(
              duration: const Duration(milliseconds: 180),
              reverseDuration: const Duration(milliseconds: 150),
              switchInCurve: Curves.easeOutCubic,
              switchOutCurve: Curves.easeInCubic,
              layoutBuilder: (currentChild, previousChildren) {
                return currentChild ?? const SizedBox.shrink();
              },
              transitionBuilder: (child, animation) {
                final isCollapsedChild =
                    child.key == const ValueKey('collapsed');
                final offset = Tween<Offset>(
                  begin: isCollapsedChild
                      ? const Offset(0, -0.08)
                      : const Offset(0, 0.05),
                  end: Offset.zero,
                ).animate(animation);
                return FadeTransition(
                  opacity: animation,
                  child: SlideTransition(position: offset, child: child),
                );
              },
              child: isCollapsed
                  ? _buildCollapsedBar(context, theme)
                  : _buildExpandedBody(context, theme),
            ),
          );
        },
      ),
    );
  }

  Widget _buildExpandedBody(BuildContext context, ThemeData theme) {
    return Align(
      key: const ValueKey('expanded'),
      alignment: const Alignment(-1, -0.30),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(24, 0, 24, 0),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            expandedCover,
            const SizedBox(width: 20),
            Expanded(child: _buildExpandedText(theme)),
          ],
        ),
      ),
    );
  }

  Widget _buildCollapsedBar(BuildContext context, ThemeData theme) {
    return SizedBox(
      key: const ValueKey('collapsed'),
      height: kToolbarHeight,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 0),
        child: Row(
          children: [
            collapsedCover,
            const SizedBox(width: 12),
            Expanded(
              child: Text(
                title,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: theme.colorScheme.onSurface,
                  fontSize: 16,
                  fontWeight: FontWeight.w900,
                ),
              ),
            ),
            if (actions != null) ...[
              const SizedBox(width: 12),
              Flexible(
                child: Align(
                  alignment: Alignment.centerRight,
                  child: SingleChildScrollView(
                    scrollDirection: Axis.horizontal,
                    child: actions!,
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildExpandedText(ThemeData theme) {
    final children = <Widget>[
      Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Text(
              title,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.titleLarge?.copyWith(
                fontSize: 24,
                fontWeight: FontWeight.w900,
                height: 1.08,
              ),
            ),
          ),
          const SizedBox(width: 12),
          _buildTypeBadge(theme),
        ],
      ),
      for (final child in detailChildren) ...[const SizedBox(height: 8), child],
      if (actions != null) ...[const SizedBox(height: 12), actions!],
    ];

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: children,
    );
  }

  Widget _buildTypeBadge(ThemeData theme) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: theme.colorScheme.primary.withAlpha(18),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(
          color: theme.colorScheme.primary.withAlpha(40),
          width: 0.5,
        ),
      ),
      child: Text(
        typeLabel,
        style: TextStyle(
          color: theme.colorScheme.primary,
          fontSize: 10,
          fontWeight: FontWeight.w900,
          letterSpacing: 1.2,
        ),
      ),
    );
  }
}
