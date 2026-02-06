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
                child: Padding(
                  padding: EdgeInsets.only(
                    bottom: selectionProvider.isSelectionMode ? 80 : 0,
                  ),
                  child: body,
                ),
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
          if (title != null && title!.isNotEmpty)
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
    
    return Container(
      margin: const EdgeInsets.only(left: 12),
      height: 32,
      child: TextButton.icon(
        onPressed: () {
          selectionProvider.setSongList(songs);
          selectionProvider.enterSelectionMode();
        },
        icon: const Icon(CupertinoIcons.checkmark_circle, size: 14), // Smaller icon
        label: const Text('批量选择', style: TextStyle(fontWeight: FontWeight.w700, fontSize: 13)),
        style: TextButton.styleFrom(
          foregroundColor: theme.colorScheme.onSurface.withAlpha(200),
          backgroundColor: theme.colorScheme.onSurface.withAlpha(15),
          padding: const EdgeInsets.symmetric(horizontal: 14),
          minimumSize: Size.zero,
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(10),
            side: BorderSide(
              color: theme.colorScheme.onSurface.withAlpha(20),
              width: 1.0,
            ),
          ),
        ),
      ),
    );
  }
}
