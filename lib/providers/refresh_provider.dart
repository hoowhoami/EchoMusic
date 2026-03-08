import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

class RefreshProvider with ChangeNotifier {
  int _refreshCounter = 0;
  String? _currentTargetKey;

  int get refreshCounter => _refreshCounter;
  String? get currentTargetKey => _currentTargetKey;

  void triggerRefresh(String? targetKey) {
    if (targetKey == null || targetKey.isEmpty) return;
    _currentTargetKey = targetKey;
    _refreshCounter++;
    notifyListeners();
  }
}

/// 优雅刷新 Mixin，减少各页面的样板代码
mixin RefreshableState<T extends StatefulWidget> on State<T> {
  RefreshProvider? _refreshProvider;
  int _lastHandledRefreshCounter = -1;

  String get refreshKey;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final provider = Provider.of<RefreshProvider>(context);
    if (_refreshProvider != provider) {
      _refreshProvider?.removeListener(_handleRefresh);
      _refreshProvider = provider;
      _refreshProvider?.addListener(_handleRefresh);
    }
  }

  @override
  void dispose() {
    _refreshProvider?.removeListener(_handleRefresh);
    super.dispose();
  }

  void _handleRefresh() {
    final provider = _refreshProvider;
    if (provider == null) return;
    if (provider.currentTargetKey != refreshKey) return;
    if (provider.refreshCounter == _lastHandledRefreshCounter) return;

    _lastHandledRefreshCounter = provider.refreshCounter;
    onRefresh();
  }

  /// 子类实现此方法即可响应刷新指令
  void onRefresh();
}