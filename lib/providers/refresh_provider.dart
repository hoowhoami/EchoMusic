import 'package:flutter/material.dart';

class RefreshProvider with ChangeNotifier {
  int _refreshCounter = 0;
  int get refreshCounter => _refreshCounter;

  void triggerRefresh() {
    _refreshCounter++;
    notifyListeners();
  }
}
