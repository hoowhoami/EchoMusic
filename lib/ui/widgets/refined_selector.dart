import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';

class RefinedSelector extends StatelessWidget {
  final String label;
  final VoidCallback onTap;
  final IconData? icon;

  const RefinedSelector({
    super.key,
    required this.label,
    required this.onTap,
    this.icon = CupertinoIcons.chevron_down,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        onTap: onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 200),
          height: 32,
          padding: const EdgeInsets.symmetric(horizontal: 14),
          decoration: BoxDecoration(
            color: theme.colorScheme.onSurface.withAlpha(15),
            borderRadius: BorderRadius.circular(10),
            border: Border.all(
              color: theme.colorScheme.onSurface.withAlpha(20),
              width: 1.0,
            ),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                label,
                style: TextStyle(
                  fontSize: 13,
                  fontWeight: FontWeight.w700,
                  color: theme.colorScheme.onSurface.withAlpha(200),
                ),
              ),
              if (icon != null) ...[
                const SizedBox(width: 8),
                Icon(
                  icon,
                  size: 14,
                  color: theme.colorScheme.onSurface.withAlpha(120),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
