import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

class RefreshProvider with ChangeNotifier {
  int _refreshCounter = 0;
  int get refreshCounter => _refreshCounter;

  void triggerRefresh() {
    _refreshCounter++;
    notifyListeners();
  }
}

/// 优雅刷新 Mixin，减少各页面的样板代码
mixin RefreshableState<T extends StatefulWidget> on State<T> {
  RefreshProvider? _refreshProvider;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final provider = Provider.of<RefreshProvider>(context);
    if (_refreshProvider != provider) {
      _refreshProvider?.removeListener(onRefresh);
      _refreshProvider = provider;
      _refreshProvider?.addListener(onRefresh);
    }
  }

  @override
  void dispose() {
    _refreshProvider?.removeListener(onRefresh);
    super.dispose();
  }

  /// 子类实现此方法即可响应刷新指令
  void onRefresh();
}