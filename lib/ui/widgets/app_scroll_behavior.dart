import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';

class AppScrollBehavior extends MaterialScrollBehavior {
  const AppScrollBehavior();

  @override
  ScrollPhysics getScrollPhysics(BuildContext context) {
    final platform = getPlatform(context);
    final physicsParent = const AlwaysScrollableScrollPhysics();

    switch (platform) {
      case TargetPlatform.windows:
      case TargetPlatform.linux:
        return ClampingScrollPhysics(parent: physicsParent);
      case TargetPlatform.macOS:
        return const BouncingScrollPhysics(parent: physicsParent);
      case TargetPlatform.android:
      case TargetPlatform.iOS:
      case TargetPlatform.fuchsia:
        return const BouncingScrollPhysics(parent: physicsParent);
    }
  }

  @override
  Set<PointerDeviceKind> get dragDevices => {
        PointerDeviceKind.touch,
        PointerDeviceKind.mouse,
        PointerDeviceKind.trackpad,
        PointerDeviceKind.stylus,
        PointerDeviceKind.unknown,
      };
}
