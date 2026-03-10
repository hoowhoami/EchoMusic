import 'package:flutter/material.dart';
import '../../models/song.dart';
import 'song_batch_selection_dialog.dart';

class BatchSelectionScaffold extends StatelessWidget {
  final Widget body;
  final List<Song> songs;
  final String? title;
  final Widget? leading;
  final Widget? appBarActions;
  final bool showAppBar;
  final dynamic sourceId;
  final Future<List<Song>> Function()? onResolveBatchSongs;

  const BatchSelectionScaffold({
    super.key,
    required this.body,
    required this.songs,
    this.title,
    this.leading,
    this.appBarActions,
    this.showAppBar = true,
    this.sourceId,
    this.onResolveBatchSongs,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Scaffold(
      backgroundColor: theme.scaffoldBackgroundColor,
      body: Column(
        children: [
          if (showAppBar) _buildHeader(context),
          Expanded(child: body),
        ],
      ),
    );
  }

  Widget _buildHeader(BuildContext context) {
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
                if (songs.isNotEmpty) _buildBatchButton(),
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
          if (songs.isNotEmpty) _buildBatchButton(),
        ],
      ),
    );
  }

  Widget _buildBatchButton() {
    return SongBatchActionButton(
      songs: songs,
      sourceId: sourceId,
      onResolveSongs: onResolveBatchSongs,
    );
  }
}
