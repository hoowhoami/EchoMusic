import 'package:flutter/material.dart';

class CustomDialog extends StatelessWidget {
  final String title;
  final String? content;
  final Widget? contentWidget;
  final String? cancelText;
  final String confirmText;
  final VoidCallback? onCancel;
  final VoidCallback onConfirm;
  final bool isDestructive;
  final double width;

  const CustomDialog({
    super.key,
    required this.title,
    this.content,
    this.contentWidget,
    this.cancelText,
    required this.confirmText,
    this.onCancel,
    required this.onConfirm,
    this.isDestructive = false,
    this.width = 400,
  });

  static Future<bool?> show(
    BuildContext context, {
    required String title,
    String? content,
    Widget? contentWidget,
    String? cancelText,
    required String confirmText,
    bool isDestructive = false,
    bool showCancel = true,
    double width = 400,
  }) {
    return showDialog<bool>(
      context: context,
      builder: (context) => CustomDialog(
        title: title,
        content: content,
        contentWidget: contentWidget,
        cancelText: showCancel ? (cancelText ?? '取消') : null,
        confirmText: confirmText,
        isDestructive: isDestructive,
        onConfirm: () => Navigator.pop(context, true),
        onCancel: showCancel ? () => Navigator.pop(context, false) : null,
        width: width,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    
    return Center(
      child: Container(
        width: width,
        margin: const EdgeInsets.symmetric(horizontal: 40, vertical: 40),
        decoration: BoxDecoration(
          color: theme.colorScheme.surface,
          borderRadius: BorderRadius.circular(24),
          boxShadow: [
            BoxShadow(
              color: Colors.black.withAlpha(40),
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
              Padding(
                padding: const EdgeInsets.fromLTRB(28, 28, 28, 16),
                child: Text(
                  title,
                  style: const TextStyle(
                    fontSize: 20,
                    fontWeight: FontWeight.w900,
                    letterSpacing: -0.5,
                  ),
                ),
              ),
              if (contentWidget != null)
                Flexible(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 28),
                    child: contentWidget!,
                  ),
                )
              else if (content != null)
                Flexible(
                  child: SingleChildScrollView(
                    physics: const BouncingScrollPhysics(),
                    padding: const EdgeInsets.fromLTRB(28, 0, 28, 24),
                    child: Text(
                      content!,
                      style: TextStyle(
                        fontSize: 14,
                        height: 1.6,
                        color: theme.colorScheme.onSurface.withAlpha(180),
                        fontWeight: FontWeight.w500,
                      ),
                    ),
                  ),
                ),
              const SizedBox(height: 24),
              Container(
                padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.end,
                  children: [
                    if (cancelText != null || onCancel != null)
                      TextButton(
                        onPressed: onCancel ?? () => Navigator.pop(context),
                        style: TextButton.styleFrom(
                          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
                          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                        ),
                        child: Text(
                          cancelText ?? '取消',
                          style: TextStyle(
                            color: theme.colorScheme.onSurface.withAlpha(120),
                            fontWeight: FontWeight.w700,
                            fontSize: 14,
                          ),
                        ),
                      ),
                    const SizedBox(width: 8),
                    ElevatedButton(
                      onPressed: onConfirm,
                      style: ElevatedButton.styleFrom(
                        backgroundColor: isDestructive 
                            ? theme.colorScheme.error 
                            : theme.colorScheme.primary,
                        foregroundColor: isDestructive
                            ? theme.colorScheme.onError
                            : theme.colorScheme.onPrimary,
                        padding: const EdgeInsets.symmetric(horizontal: 28, vertical: 16),
                        elevation: 0,
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                      ),
                      child: Text(
                        confirmText,
                        style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 14),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}