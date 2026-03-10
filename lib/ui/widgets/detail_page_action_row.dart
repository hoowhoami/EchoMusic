import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';

import '../../models/song.dart';
import 'song_batch_selection_dialog.dart';

class DetailPageSecondaryAction {
  final IconData icon;
  final String label;
  final VoidCallback? onTap;
  final bool emphasized;
  final bool destructive;

  const DetailPageSecondaryAction({
    required this.icon,
    required this.label,
    this.onTap,
    this.emphasized = false,
    this.destructive = false,
  });
}

class DetailPageActionRow extends StatelessWidget {
  final String playLabel;
  final VoidCallback? onPlay;
  final List<Song> songs;
  final dynamic sourceId;
  final Future<List<Song>> Function()? onResolveSongs;
  final bool isBatchPreparing;
  final DetailPageSecondaryAction? secondaryAction;

  const DetailPageActionRow({
    super.key,
    required this.playLabel,
    required this.onPlay,
    required this.songs,
    this.sourceId,
    this.onResolveSongs,
    this.isBatchPreparing = false,
    this.secondaryAction,
  });

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (secondaryAction != null) ...[
          _SecondaryActionButton(
            action: secondaryAction!,
          ),
          const SizedBox(width: 8),
        ],
        _PrimaryActionButton(
          icon: CupertinoIcons.play_fill,
          label: playLabel,
          onPressed: songs.isEmpty ? null : onPlay,
        ),
        const SizedBox(width: 8),
        SongBatchActionButton(
          songs: songs,
          sourceId: sourceId,
          onResolveSongs: onResolveSongs,
          isLoadingHint: isBatchPreparing,
        ),
      ],
    );
  }
}

class _PrimaryActionButton extends StatelessWidget {
  final IconData icon;
  final String label;
  final VoidCallback? onPressed;

  const _PrimaryActionButton({
    required this.icon,
    required this.label,
    this.onPressed,
  });

  @override
  Widget build(BuildContext context) {
    return FilledButton.icon(
      onPressed: onPressed,
      icon: Icon(icon, size: 16),
      label: Text(label),
      style: _buildFilledActionStyle(context),
    );
  }
}

class _SecondaryActionButton extends StatelessWidget {
  final DetailPageSecondaryAction action;

  const _SecondaryActionButton({required this.action});

  @override
  Widget build(BuildContext context) {
    return FilledButton.icon(
      onPressed: action.onTap,
      icon: Icon(action.icon, size: 16),
      label: Text(action.label),
      style: _buildFilledActionStyle(context),
    );
  }
}

ButtonStyle _buildFilledActionStyle(BuildContext context) {
  final theme = Theme.of(context);
  return FilledButton.styleFrom(
    backgroundColor: theme.colorScheme.surfaceContainerHighest,
    foregroundColor: theme.colorScheme.onSurface,
    disabledBackgroundColor: theme.colorScheme.onSurface.withAlpha(20),
    disabledForegroundColor: theme.disabledColor,
    minimumSize: const Size(0, 36),
    padding: const EdgeInsets.symmetric(horizontal: 12),
    shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)),
    tapTargetSize: MaterialTapTargetSize.shrinkWrap,
    textStyle: const TextStyle(fontSize: 12, fontWeight: FontWeight.w700),
  );
}