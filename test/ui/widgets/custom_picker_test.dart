import 'package:echomusic/ui/widgets/custom_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('custom picker renders options as wrapped tags', (tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () {
                CustomPicker.show(
                  context,
                  title: '专辑类型',
                  options: [
                    PickerOption(id: 'all', name: '全部'),
                    PickerOption(id: 'ep', name: 'EP'),
                    PickerOption(id: 'live', name: '现场'),
                  ],
                  selectedId: 'all',
                  onSelected: (_) {},
                  maxWidth: 360,
                );
              },
              child: const Text('open'),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    expect(find.byType(Wrap), findsOneWidget);
    expect(find.text('全部'), findsOneWidget);
    expect(find.text('EP'), findsOneWidget);
    expect(find.text('现场'), findsOneWidget);
  });
}