import 'package:echomusic/ui/widgets/lazy_indexed_stack.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

class _ProbePage extends StatefulWidget {
  const _ProbePage({required this.label, required this.onInit});

  final String label;
  final VoidCallback onInit;

  @override
  State<_ProbePage> createState() => _ProbePageState();
}

class _ProbePageState extends State<_ProbePage> {
  @override
  void initState() {
    super.initState();
    widget.onInit();
  }

  @override
  Widget build(BuildContext context) => Text(widget.label);
}

void main() {
  testWidgets('recreates configured pages when they become active again', (
    tester,
  ) async {
    var historyInitCount = 0;
    var recommendInitCount = 0;

    Widget buildApp(int index) {
      return MaterialApp(
        home: LazyIndexedStack(
          index: index,
          itemCount: 2,
          recreateOnActivateIndices: const <int>{1},
          itemBuilder: (itemIndex) {
            switch (itemIndex) {
              case 0:
                return _ProbePage(
                  label: 'recommend',
                  onInit: () => recommendInitCount++,
                );
              case 1:
                return _ProbePage(
                  label: 'history',
                  onInit: () => historyInitCount++,
                );
              default:
                return const SizedBox.shrink();
            }
          },
        ),
      );
    }

    await tester.pumpWidget(buildApp(0));
    expect(recommendInitCount, 1);
    expect(historyInitCount, 0);

    await tester.pumpWidget(buildApp(1));
    await tester.pump();
    expect(recommendInitCount, 1);
    expect(historyInitCount, 1);

    await tester.pumpWidget(buildApp(0));
    await tester.pump();
    expect(recommendInitCount, 1);
    expect(historyInitCount, 1);

    await tester.pumpWidget(buildApp(1));
    await tester.pump();
    expect(historyInitCount, 2);
  });

  testWidgets('recreates configured page when activation version changes', (
    tester,
  ) async {
    var historyInitCount = 0;

    Widget buildApp(int activationVersion) {
      return MaterialApp(
        home: LazyIndexedStack(
          index: 1,
          itemCount: 2,
          activationVersion: activationVersion,
          recreateOnActivateIndices: const <int>{1},
          itemBuilder: (itemIndex) {
            if (itemIndex == 1) {
              return _ProbePage(
                label: 'history',
                onInit: () => historyInitCount++,
              );
            }
            return const SizedBox.shrink();
          },
        ),
      );
    }

    await tester.pumpWidget(buildApp(0));
    expect(historyInitCount, 1);

    await tester.pumpWidget(buildApp(1));
    await tester.pump();
    expect(historyInitCount, 2);
  });
}
