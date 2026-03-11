import 'package:echomusic/ui/widgets/custom_selector.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('custom selector keeps compact capsule size in wide layouts', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(
            width: 600,
            child: Row(
              children: [
                CustomSelector(label: '全部类型', onTap: () {}),
              ],
            ),
          ),
        ),
      ),
    );

    final selectorBox = tester.renderObject<RenderBox>(
      find.byType(AnimatedContainer),
    );

    expect(selectorBox.size.height, 36);
    expect(selectorBox.size.width, lessThan(220));
  });
}