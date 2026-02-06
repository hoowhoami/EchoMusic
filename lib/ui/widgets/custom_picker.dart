import 'dart:ui';
import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import '../../theme/app_theme.dart';
import 'custom_tab_bar.dart';

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
    final theme = Theme.of(context);
    final modernTheme = theme.extension<AppModernTheme>()!;
    final bool useTabs = _tabController != null;

    return Container(
      constraints: BoxConstraints(
        maxWidth: widget.maxWidth!, 
        maxHeight: MediaQuery.of(context).size.height * 0.7,
      ),
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
                  if (useTabs)
                    Padding(
                      padding: const EdgeInsets.fromLTRB(24, 0, 24, 16),
                      child: CustomTabBar(
                        controller: _tabController!,
                        tabs: _groupNames,
                      ),
                    ),
                  Flexible(
                    child: useTabs
                        ? SizedBox(
                            height: 320, // Tab 模式下给一个固定参考高度
                            child: TabBarView(
                              controller: _tabController,
                              physics: const BouncingScrollPhysics(),
                              children: _groupNames.map((name) {
                                return _buildScrollArea(context, _groupedOptions[name]!, modernTheme);
                              }).toList(),
                            ),
                          )
                        : _buildScrollArea(context, widget.options, modernTheme),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildScrollArea(BuildContext context, List<PickerOption> items, AppModernTheme modernTheme) {
    return SingleChildScrollView(
      padding: const EdgeInsets.fromLTRB(24, 0, 24, 24),
      physics: const BouncingScrollPhysics(),
      child: Wrap(
        spacing: 10,
        runSpacing: 10,
        children: items.map((item) {
          final isSelected = item.id == widget.selectedId;
          return _buildTag(context, item, isSelected, modernTheme);
        }).toList(),
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
            widget.title,
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

  Widget _buildTag(BuildContext context, PickerOption item, bool isSelected, AppModernTheme modernTheme) {
    final theme = Theme.of(context);
    return InkWell(
      onTap: () {
        widget.onSelected(item);
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
