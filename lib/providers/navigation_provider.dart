import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';

class NavigationProvider extends ChangeNotifier {
  final GlobalKey<NavigatorState> _contentNavigatorKey = GlobalKey<NavigatorState>();

  GlobalKey<NavigatorState> get navigatorKey => _contentNavigatorKey;

  void push(Widget page, {String? name, dynamic arguments}) {
    _contentNavigatorKey.currentState?.push(
      CupertinoPageRoute(
        builder: (_) => page,
        settings: RouteSettings(name: name, arguments: arguments),
      ),
    );
  }

  void pop() {
    _contentNavigatorKey.currentState?.pop();
  }

  void popUntilFirst() {
    _contentNavigatorKey.currentState?.popUntil((route) => route.isFirst);
  }
}
