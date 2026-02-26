import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import '../../models/song.dart';
import '../../providers/selection_provider.dart';
import 'batch_action_bar.dart';

class BatchSelectionScaffold extends StatelessWidget {
  final Widget body;
  final List<Song> songs;
  final String? title;
  final Widget? leading;
  final Widget? appBarActions;
  final bool showAppBar;

  const BatchSelectionScaffold({
    super.key,
    required this.body,
    required this.songs,
    this.title,
    this.leading,
    this.appBarActions,
    this.showAppBar = true,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final selectionProvider = context.watch<SelectionProvider>();

    return Scaffold(
      backgroundColor: theme.scaffoldBackgroundColor,
      body: Stack(
        children: [
          Column(
            children: [
              if (showAppBar)
                _buildHeader(context, selectionProvider),
              Expanded(
                child: body,
              ),
            ],
          ),
          const BatchActionBar(),
        ],
      ),
    );
  }

  Widget _buildHeader(BuildContext context, SelectionProvider selectionProvider) {
    final theme = Theme.of(context);
    
    return Padding(
      padding: const EdgeInsets.fromLTRB(40, 10, 40, 10), // Reduced vertical padding
      child: Row(
        children: [
          if (leading != null) ...[
            leading!,
            const SizedBox(width: 12),
          ],
          if (title?.isNotEmpty ?? false)
            Text(
              title!,
              style: TextStyle(
                fontSize: 28,
                fontWeight: FontWeight.w800,
                color: theme.colorScheme.onSurface,
                letterSpacing: -0.6,
              ),
            ),
          const Spacer(),
          if (appBarActions != null) appBarActions!,
          if (songs.isNotEmpty && !selectionProvider.isSelectionMode)
            _buildBatchButton(context, selectionProvider),
        ],
      ),
    );
  }

  Widget _buildBatchButton(BuildContext context, SelectionProvider selectionProvider) {
    final theme = Theme.of(context);
    
    return InkWell(
      onTap: () {
        selectionProvider.setSongList(songs);
        selectionProvider.enterSelectionMode();
      },
      borderRadius: BorderRadius.circular(10),
      child: Container(
        height: 36,
        padding: const EdgeInsets.symmetric(horizontal: 12),
        decoration: BoxDecoration(
          color: theme.colorScheme.onSurface.withAlpha(15),
          borderRadius: BorderRadius.circular(10),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              CupertinoIcons.checkmark_circle,
              size: 16,
              color: theme.colorScheme.onSurface.withAlpha(200),
            ),
            const SizedBox(width: 6),
            Text(
              '批量操作',
              style: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w700,
                color: theme.colorScheme.onSurface.withAlpha(200),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
