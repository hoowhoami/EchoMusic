import 'package:flutter/cupertino.dart';

class NavigationProvider extends ChangeNotifier {
  final GlobalKey<NavigatorState> _contentNavigatorKey = GlobalKey<NavigatorState>();
  late final NavigatorObserver _observer = _NavigationStateObserver(this);
  String? _currentRouteName;
  dynamic _currentRouteArguments;

  GlobalKey<NavigatorState> get navigatorKey => _contentNavigatorKey;
  NavigatorObserver get observer => _observer;
  String? get currentRouteName => _currentRouteName;
  dynamic get currentRouteArguments => _currentRouteArguments;

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

  bool isCurrentRoute(String routeName, {int? id}) {
    if (_currentRouteName != routeName) return false;
    if (id == null) return true;

    final args = _currentRouteArguments;
    if (args is! Map) return false;

    final dynamic rawId = args['id'];
    if (rawId is int) return rawId == id;
    return int.tryParse('$rawId') == id;
  }

  void _updateCurrentRoute(Route<dynamic>? route) {
    final nextName = route?.settings.name;
    final nextArguments = route?.settings.arguments;

    final changed = _currentRouteName != nextName || !identical(_currentRouteArguments, nextArguments);
    _currentRouteName = nextName;
    _currentRouteArguments = nextArguments;

    if (changed) {
      notifyListeners();
    }
  }
}

class _NavigationStateObserver extends NavigatorObserver {
  final NavigationProvider provider;

  _NavigationStateObserver(this.provider);

  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) {
    provider._updateCurrentRoute(route);
    super.didPush(route, previousRoute);
  }

  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) {
    provider._updateCurrentRoute(previousRoute);
    super.didPop(route, previousRoute);
  }

  @override
  void didReplace({Route<dynamic>? newRoute, Route<dynamic>? oldRoute}) {
    provider._updateCurrentRoute(newRoute);
    super.didReplace(newRoute: newRoute, oldRoute: oldRoute);
  }

  @override
  void didRemove(Route<dynamic> route, Route<dynamic>? previousRoute) {
    provider._updateCurrentRoute(previousRoute);
    super.didRemove(route, previousRoute);
  }
}
