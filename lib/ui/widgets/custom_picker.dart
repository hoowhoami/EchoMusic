import 'dart:ui';
import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import '../../theme/app_theme.dart';

class PickerOption {
  final String id;
  final String name;
  final String? group;

  PickerOption({required this.id, required this.name, this.group});
}

class CustomPicker extends StatelessWidget {
  final String title;
  final List<PickerOption> options;
  final String selectedId;
  final Function(PickerOption) onSelected;
  final double? maxWidth;

  const CustomPicker({
    super.key,
    required this.title,
    required this.options,
    required this.selectedId,
    required this.onSelected,
    this.maxWidth = 500,
  });

  static void show(
    BuildContext context, {
    required String title,
    required List<PickerOption> options,
    required String selectedId,
    required Function(PickerOption) onSelected,
    double? maxWidth = 500,
  }) {
    showGeneralDialog(
      context: context,
      barrierDismissible: true,
      barrierLabel: 'CustomPicker',
      barrierColor: Colors.black.withAlpha(20),
      transitionDuration: const Duration(milliseconds: 250),
      pageBuilder: (context, animation, secondaryAnimation) => Center(
        child: ScaleTransition(
          scale: CurvedAnimation(parent: animation, curve: Curves.easeOutCubic),
          child: FadeTransition(
            opacity: animation,
            child: CustomPicker(
              title: title,
              options: options,
              selectedId: selectedId,
              onSelected: onSelected,
              maxWidth: maxWidth,
            ),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final modernTheme = theme.extension<AppModernTheme>()!;
    
    // 分组逻辑
    final Map<String, List<PickerOption>> groupedOptions = {};
    for (var opt in options) {
      final key = opt.group ?? '';
      if (!groupedOptions.containsKey(key)) groupedOptions[key] = [];
      groupedOptions[key]!.add(opt);
    }

    return Container(
      constraints: BoxConstraints(maxWidth: maxWidth!),
      margin: const EdgeInsets.all(24),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(24),
        child: BackdropFilter(
          filter: ImageFilter.blur(sigmaX: 20, sigmaY: 20),
          child: Container(
            decoration: BoxDecoration(
              color: modernTheme.modalColor,
              borderRadius: BorderRadius.circular(24),
              border: Border.all(
                color: theme.colorScheme.primary.withAlpha(40),
                width: 1.2,
              ),
              boxShadow: [
                BoxShadow(
                  color: Colors.black.withAlpha(20),
                  blurRadius: 30,
                  offset: const Offset(0, 10),
                ),
              ],
            ),
            child: Material(
              color: Colors.transparent,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  _buildHeader(context),
                  Flexible(
                    child: SingleChildScrollView(
                      padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
                      physics: const BouncingScrollPhysics(),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: groupedOptions.entries.map((entry) {
                          return _buildGroup(context, entry.key, entry.value, modernTheme);
                        }).toList(),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildHeader(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(24, 20, 12, 12),
      child: Row(
        children: [
          Text(
            title,
            style: TextStyle(
              fontSize: 16,
              fontWeight: FontWeight.w900,
              color: theme.colorScheme.onSurface,
              letterSpacing: -0.5,
            ),
          ),
          const Spacer(),
          CupertinoButton(
            padding: EdgeInsets.zero,
            onPressed: () => Navigator.pop(context),
            child: Container(
              padding: const EdgeInsets.all(6),
              decoration: BoxDecoration(
                color: theme.colorScheme.onSurface.withAlpha(15),
                shape: BoxShape.circle,
              ),
              child: Icon(
                CupertinoIcons.xmark,
                size: 14,
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildGroup(BuildContext context, String groupName, List<PickerOption> items, AppModernTheme modernTheme) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (groupName.isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 12, bottom: 8, left: 4),
            child: Text(
              groupName.toUpperCase(),
              style: TextStyle(
                fontSize: 10,
                fontWeight: FontWeight.w900,
                color: theme.colorScheme.primary.withAlpha(200),
                letterSpacing: 1.2,
              ),
            ),
          ),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: items.map((item) {
            final isSelected = item.id == selectedId;
            return _buildTag(context, item, isSelected, modernTheme);
          }).toList(),
        ),
      ],
    );
  }

  Widget _buildTag(BuildContext context, PickerOption item, bool isSelected, AppModernTheme modernTheme) {
    final theme = Theme.of(context);
    return InkWell(
      onTap: () {
        onSelected(item);
        Navigator.pop(context);
      },
      borderRadius: BorderRadius.circular(10),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 200),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 7),
        decoration: BoxDecoration(
          color: isSelected 
            ? theme.colorScheme.primary 
            : theme.colorScheme.onSurface.withAlpha(15),
          borderRadius: BorderRadius.circular(10),
          border: Border.all(
            color: isSelected 
              ? theme.colorScheme.primary 
              : theme.colorScheme.onSurface.withAlpha(30),
            width: 1,
          ),
        ),
        child: Text(
          item.name,
          style: TextStyle(
            fontSize: 12,
            fontWeight: isSelected ? FontWeight.w800 : FontWeight.w600,
            color: isSelected 
              ? (theme.brightness == Brightness.light ? Colors.white : modernTheme.tabSelectedTextColor)
              : theme.colorScheme.onSurface.withAlpha(200),
          ),
        ),
      ),
    );
  }
}