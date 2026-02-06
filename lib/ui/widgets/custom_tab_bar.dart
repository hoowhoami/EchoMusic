import 'package:flutter/material.dart';
import '../../theme/app_theme.dart';

class CustomTabBar extends StatelessWidget {
  final TabController controller;
  final List<String> tabs;
  final Function(int)? onTap;

  const CustomTabBar({
    super.key,
    required this.controller,
    required this.tabs,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final modernTheme = theme.extension<AppModernTheme>()!;
    
    return LayoutBuilder(
      builder: (context, constraints) {
        final totalWidth = constraints.maxWidth;
        final itemWidth = (totalWidth - 8) / tabs.length;

        return Container(
          width: double.infinity,
          height: 42,
          padding: const EdgeInsets.all(4),
          decoration: BoxDecoration(
            color: theme.colorScheme.onSurface.withAlpha(8),
            borderRadius: BorderRadius.circular(12),
            border: Border.all(
              color: theme.colorScheme.onSurface.withAlpha(15),
              width: 1,
            ),
          ),
          child: Stack(
            children: [
              // Sliding background
              AnimatedBuilder(
                animation: controller.animation!,
                builder: (context, child) {
                  return Positioned(
                    left: controller.animation!.value * itemWidth,
                    top: 0,
                    bottom: 0,
                    width: itemWidth,
                    child: Container(
                      decoration: BoxDecoration(
                        color: modernTheme.tabSliderColor,
                        borderRadius: BorderRadius.circular(9),
                        boxShadow: theme.brightness == Brightness.light
                            ? [
                                BoxShadow(
                                  color: Colors.black.withAlpha(15),
                                  blurRadius: 4,
                                  offset: const Offset(0, 2),
                                )
                              ]
                            : null,
                      ),
                    ),
                  );
                },
              ),
              // Tab labels
              Row(
                children: List.generate(tabs.length, (index) {
                  return Expanded(
                    child: _buildTabItem(context, tabs[index], index, modernTheme),
                  );
                }),
              ),
            ],
          ),
        );
      },
    );
  }

  Widget _buildTabItem(BuildContext context, String label, int index, AppModernTheme modernTheme) {
    final theme = Theme.of(context);

    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () {
          controller.animateTo(index);
          if (onTap != null) onTap!(index);
        },
        child: Center(
          child: AnimatedBuilder(
            animation: controller.animation!,
            builder: (context, child) {
              final double selectionProgress = (controller.animation!.value - index).abs();
              final bool isSelected = selectionProgress < 0.5;
              
              return Text(
                label,
                style: TextStyle(
                  fontSize: 13,
                  fontWeight: isSelected ? FontWeight.w900 : FontWeight.w600,
                  color: isSelected 
                    ? modernTheme.tabSelectedTextColor
                    : theme.colorScheme.onSurface.withAlpha(120),
                ),
              );
            },
          ),
        ),
      ),
    );
  }
}