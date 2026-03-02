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

    return Scaffold(
      backgroundColor: theme.scaffoldBackgroundColor,
      body: Stack(
        children: [
          Column(
            children: [
              if (showAppBar)
                Selector<SelectionProvider, bool>(
                  selector: (_, p) => p.isSelectionMode,
                  builder: (context, isSelectionMode, _) =>
                      _buildHeader(context, isSelectionMode),
                ),
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

  Widget _buildHeader(BuildContext context, bool isSelectionMode) {
    final theme = Theme.of(context);
    final hasTwoRows = (title?.isNotEmpty ?? false) && appBarActions != null;

    if (hasTwoRows) {
      return Padding(
        padding: const EdgeInsets.fromLTRB(40, 10, 40, 10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              title!,
              style: TextStyle(
                fontSize: 28,
                fontWeight: FontWeight.w800,
                color: theme.colorScheme.onSurface,
                letterSpacing: -0.6,
              ),
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                appBarActions!,
                const Spacer(),
                if (songs.isNotEmpty && !isSelectionMode)
                  _buildBatchButton(context),
              ],
            ),
          ],
        ),
      );
    }

    return Padding(
      padding: const EdgeInsets.fromLTRB(40, 10, 40, 10),
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
          if (songs.isNotEmpty && !isSelectionMode)
            _buildBatchButton(context),
        ],
      ),
    );
  }

  Widget _buildBatchButton(BuildContext context) {
    final theme = Theme.of(context);

    return InkWell(
      onTap: () {
        final p = context.read<SelectionProvider>();
        p.setSongList(songs);
        p.enterSelectionMode();
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
