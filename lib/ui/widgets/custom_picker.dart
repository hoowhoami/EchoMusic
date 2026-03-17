import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';

import 'app_menu.dart';
import 'custom_tab_bar.dart';
import 'package:echomusic/theme/app_theme.dart';

class PickerOption {
  final String id;
  final String name;
  final String? group;

  PickerOption({required this.id, required this.name, this.group});
}

class CustomPicker extends StatefulWidget {
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
      barrierColor: Colors.black.withAlpha(36),
      transitionDuration: const Duration(milliseconds: 250),
      pageBuilder: (context, animation, secondaryAnimation) => Center(
        child: CustomPicker(
          title: title,
          options: options,
          selectedId: selectedId,
          onSelected: onSelected,
          maxWidth: maxWidth,
        ),
      ),
      transitionBuilder: (context, animation, _, child) {
        final curved = CurvedAnimation(parent: animation, curve: Curves.easeOutCubic);
        return FadeTransition(
          opacity: curved,
          child: SlideTransition(
            position: Tween<Offset>(
              begin: const Offset(0, 0.02),
              end: Offset.zero,
            ).animate(curved),
            child: child,
          ),
        );
      },
    );
  }

  @override
  State<CustomPicker> createState() => _CustomPickerState();
}

class _CustomPickerState extends State<CustomPicker> with SingleTickerProviderStateMixin {
  late Map<String, List<PickerOption>> _groupedOptions;
  late List<String> _groupNames;
  TabController? _tabController;

  @override
  void initState() {
    super.initState();
    _initGroups();
  }

  void _initGroups() {
    _groupedOptions = {};
    for (var opt in widget.options) {
      final key = opt.group ?? '';
      if (!_groupedOptions.containsKey(key)) _groupedOptions[key] = [];
      _groupedOptions[key]!.add(opt);
    }
    
    // 如果只有一个空白组名，则视为不分组
    if (_groupedOptions.length == 1 && _groupedOptions.containsKey('')) {
      _groupNames = [];
    } else {
      _groupNames = _groupedOptions.keys.where((k) => k.isNotEmpty).toList();
    }

    if (_groupNames.length > 1) {
      int initialIndex = 0;
      for (int i = 0; i < _groupNames.length; i++) {
        if (_groupedOptions[_groupNames[i]]!.any((opt) => opt.id == widget.selectedId)) {
          initialIndex = i;
          break;
        }
      }
      _tabController = TabController(length: _groupNames.length, vsync: this, initialIndex: initialIndex);
    }
  }

  @override
  void dispose() {
    _tabController?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final bool useTabs = _tabController != null;

    return Padding(
      padding: const EdgeInsets.all(24),
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxWidth: widget.maxWidth!,
          maxHeight: MediaQuery.of(context).size.height * 0.7,
        ),
        child: Material(
          color: Colors.transparent,
          child: AppMenuPanel(
            padding: const EdgeInsets.fromLTRB(10, 10, 10, 10),
            borderRadius: const BorderRadius.all(Radius.circular(24)),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _buildHeader(context),
                if (useTabs)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(14, 0, 14, 12),
                    child: CustomTabBar(
                      controller: _tabController!,
                      tabs: _groupNames,
                    ),
                  ),
                Flexible(
                  child: useTabs
                      ? SizedBox(
                          height: 320,
                          child: TabBarView(
                            controller: _tabController,
                            physics: const BouncingScrollPhysics(),
                            children: _groupNames
                                .map((name) => _buildOptionWrap(
                                      context,
                                      _groupedOptions[name]!,
                                    ))
                                .toList(),
                          ),
                        )
                      : _buildOptionWrap(context, widget.options),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildOptionWrap(BuildContext context, List<PickerOption> items) {
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(14, 0, 14, 14),
      physics: const BouncingScrollPhysics(),
      child: Wrap(
        spacing: 10,
        runSpacing: 10,
        children: items
            .map(
              (item) => _buildTag(
                context,
                item,
                item.id == widget.selectedId,
              ),
            )
            .toList(),
      ),
    );
  }

  Widget _buildTag(BuildContext context, PickerOption item, bool isSelected) {
    final theme = Theme.of(context);

    return InkWell(
      onTap: () {
        widget.onSelected(item);
        Navigator.of(context).pop();
      },
      borderRadius: BorderRadius.circular(10),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 180),
        curve: Curves.easeOut,
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
            fontWeight: isSelected ? AppTheme.fontWeightBold : AppTheme.fontWeightSemiBold,
            color: isSelected
                ? (theme.brightness == Brightness.light
                    ? Colors.white
                    : Colors.black)
                : theme.colorScheme.onSurface.withAlpha(200),
          ),
        ),
      ),
    );
  }

  Widget _buildHeader(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 6, 6, 12),
      child: Row(
        children: [
          Container(
            width: 34,
            height: 34,
            decoration: BoxDecoration(
              color: theme.colorScheme.primary.withAlpha(18),
              borderRadius: BorderRadius.circular(12),
            ),
            child: Icon(
              CupertinoIcons.square_grid_2x2,
              size: 16,
              color: theme.colorScheme.primary,
            ),
          ),
          const SizedBox(width: 12),
          Text(
            widget.title,
            style: TextStyle(
              fontSize: 16,
              fontWeight: AppTheme.fontWeightBold,
              color: theme.colorScheme.onSurface,
              letterSpacing: -0.5,
            ),
          ),
          const Spacer(),
          IconButton(
            padding: EdgeInsets.zero,
            constraints: const BoxConstraints(minWidth: 32, minHeight: 32),
            tooltip: '关闭',
            onPressed: () => Navigator.pop(context),
            icon: Icon(
              CupertinoIcons.xmark,
              size: 16,
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
        ],
      ),
    );
  }
}
