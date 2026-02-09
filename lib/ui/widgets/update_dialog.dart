import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import 'custom_dialog.dart';

class UpdateDialog extends StatelessWidget {
  final String version;
  final String? releaseNotes;
  final bool isLatest;

  const UpdateDialog({
    super.key,
    required this.version,
    this.releaseNotes,
    this.isLatest = false,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    
    return CustomDialog(
      title: isLatest ? '已是最新版本' : '发现新版本',
      width: 450,
      confirmText: isLatest ? '关闭' : '前往下载',
      cancelText: isLatest ? null : '稍后再说',
      onConfirm: () async {
        if (isLatest) {
          Navigator.of(context).pop();
        } else {
          final url = Uri.parse('https://github.com/hoowhoami/EchoMusic/releases');
          if (await canLaunchUrl(url)) {
            await launchUrl(url);
          }
          if (context.mounted) Navigator.of(context).pop();
        }
      },
      contentWidget: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            isLatest ? '当前版本 v$version' : '新版本 $version 可用',
            style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w700),
          ),
          if (releaseNotes != null && releaseNotes!.isNotEmpty) ...[
            const SizedBox(height: 16),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: theme.colorScheme.onSurface.withAlpha(10),
                borderRadius: BorderRadius.circular(16),
              ),
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxHeight: 200),
                child: SingleChildScrollView(
                  physics: const BouncingScrollPhysics(),
                  child: Text(
                    releaseNotes!,
                    style: TextStyle(
                      fontSize: 13,
                      height: 1.5,
                      color: theme.colorScheme.onSurface.withAlpha(200),
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}