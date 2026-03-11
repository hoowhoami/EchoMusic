import 'package:flutter/material.dart';

class LazyIndexedStack extends StatefulWidget {
  const LazyIndexedStack({
    super.key,
    required this.index,
    required this.itemCount,
    required this.itemBuilder,
    this.activationVersion = 0,
    this.recreateOnActivateIndices = const <int>{},
  });

  final int index;
  final int itemCount;
  final Widget Function(int index) itemBuilder;
  final int activationVersion;
  final Set<int> recreateOnActivateIndices;

  @override
  State<LazyIndexedStack> createState() => _LazyIndexedStackState();
}

class _LazyIndexedStackState extends State<LazyIndexedStack> {
  late List<bool> _activated;
  late List<Widget?> _children;
  late List<int> _versions;

  @override
  void initState() {
    super.initState();
    _initializeCache();
    _activateIndex(widget.index);
  }

  @override
  void didUpdateWidget(covariant LazyIndexedStack oldWidget) {
    super.didUpdateWidget(oldWidget);

    if (widget.itemCount != oldWidget.itemCount) {
      _initializeCache();
      _activateIndex(widget.index);
      return;
    }

    final switchedIndex = widget.index != oldWidget.index;
    final activationChanged =
        widget.activationVersion != oldWidget.activationVersion;
    final shouldRecreate =
        widget.recreateOnActivateIndices.contains(widget.index) &&
        (switchedIndex || activationChanged);

    if (!_activated[widget.index] || shouldRecreate) {
      setState(() {
        _activateIndex(widget.index, recreate: shouldRecreate);
      });
    }
  }

  void _initializeCache() {
    _activated = List<bool>.filled(widget.itemCount, false);
    _children = List<Widget?>.filled(widget.itemCount, null);
    _versions = List<int>.filled(widget.itemCount, 0);
  }

  void _activateIndex(int index, {bool recreate = false}) {
    _activated[index] = true;
    if (recreate) {
      _versions[index]++;
    }
    if (_children[index] == null || recreate) {
      _children[index] = KeyedSubtree(
        key: ValueKey('lazy-indexed-stack-$index-${_versions[index]}'),
        child: widget.itemBuilder(index),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return IndexedStack(
      index: widget.index,
      children: [
        for (int i = 0; i < widget.itemCount; i++)
          _activated[i] ? _children[i]! : const SizedBox.shrink(),
      ],
    );
  }
}
