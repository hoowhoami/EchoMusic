import 'package:echomusic/providers/navigation_provider.dart';
import 'package:echomusic/ui/widgets/app_menu.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:provider/provider.dart';

void main() {
  Future<void> pumpPlayerAnchor(
    WidgetTester tester, {
    required Alignment alignment,
    required Alignment targetAnchor,
    required Alignment followerAnchor,
    required Offset offset,
  }) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Align(
            alignment: alignment,
            child: PlayerMenuAnchor<void>(
              width: 160,
              height: 120,
              targetAnchor: targetAnchor,
              followerAnchor: followerAnchor,
              offset: offset,
              builder: (context, toggle, isOpen) => ElevatedButton(
                key: const ValueKey('trigger'),
                onPressed: toggle,
                child: const Text('打开菜单'),
              ),
              menuBuilder: (context, close) => const Center(child: Text('菜单内容')),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.byKey(const ValueKey('trigger')));
    await tester.pump();
    await tester.pump();
  }

  Future<void> pumpDropdownAnchor(
    WidgetTester tester, {
    required Alignment alignment,
    required Alignment targetAnchor,
    required Alignment followerAnchor,
    required Offset offset,
  }) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Align(
            alignment: alignment,
            child: AppDropdownAnchor<void>(
              width: 160,
              height: 120,
              targetAnchor: targetAnchor,
              followerAnchor: followerAnchor,
              offset: offset,
              builder: (context, toggle, isOpen) => ElevatedButton(
                key: const ValueKey('trigger'),
                onPressed: toggle,
                child: const Text('打开菜单'),
              ),
              menuBuilder: (context, close) => const Center(child: Text('菜单内容')),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.byKey(const ValueKey('trigger')));
    await tester.pump();
    await tester.pump();
  }

  Future<void> pumpContextMenu(
    WidgetTester tester, {
    required Alignment alignment,
    required bool useTapPosition,
  }) async {
    final triggerKey = GlobalKey();

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Align(
            alignment: alignment,
            child: Builder(
              builder: (context) => ElevatedButton(
                key: triggerKey,
                onPressed: () {
                  final triggerContext = triggerKey.currentContext!;
                  final box = triggerContext.findRenderObject() as RenderBox;
                  final tapPosition = box.localToGlobal(
                    Offset(box.size.width, box.size.height),
                  );

                  showAppContextMenu<void>(
                    context,
                    width: 180,
                    estimatedHeight: 120,
                    tapPosition: useTapPosition ? tapPosition : null,
                    anchorContext: useTapPosition ? null : triggerContext,
                    alignRightToAnchor: !useTapPosition,
                    menuBuilder: (context, close) => Column(
                      key: const ValueKey('context-menu-content'),
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: List.generate(
                        6,
                        (index) => AppMenuItemButton(
                          title: Text('菜单项 $index'),
                          onPressed: () => close(),
                        ),
                      ),
                    ),
                  );
                },
                child: Text(useTapPosition ? '打开点位菜单' : '打开锚点菜单'),
              ),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.byKey(triggerKey));
    await tester.pump();
    await tester.pump();
  }

  testWidgets('bottom anchored menu stays attached above trigger', (tester) async {
    await pumpPlayerAnchor(
      tester,
      alignment: Alignment.bottomCenter,
      targetAnchor: Alignment.topCenter,
      followerAnchor: Alignment.bottomCenter,
      offset: const Offset(0, -10),
    );

    final triggerRect = tester.getRect(find.byKey(const ValueKey('trigger')));
    final menuRect = tester.getRect(find.byType(AppMenuPanel));

    expect(menuRect.bottom, closeTo(triggerRect.top - 10, 0.1));
    expect(menuRect.center.dx, closeTo(triggerRect.center.dx, 0.1));
    expect(menuRect.top, greaterThanOrEqualTo(12));
  });

  testWidgets('right aligned dropdown opens below trigger within viewport', (
    tester,
  ) async {
    await pumpDropdownAnchor(
      tester,
      alignment: Alignment.topRight,
      targetAnchor: Alignment.bottomRight,
      followerAnchor: Alignment.topRight,
      offset: const Offset(0, 8),
    );

    final triggerRect = tester.getRect(find.byKey(const ValueKey('trigger')));
    final menuRect = tester.getRect(find.byType(AppMenuPanel));
    final windowWidth = tester.view.physicalSize.width / tester.view.devicePixelRatio;

    expect(menuRect.top, closeTo(triggerRect.bottom + 8, 0.1));
    expect(menuRect.right, closeTo(triggerRect.right, 0.1));
    expect(menuRect.left, lessThanOrEqualTo(triggerRect.left));
    expect(menuRect.left, greaterThanOrEqualTo(0));
    expect(menuRect.right, lessThanOrEqualTo(windowWidth));
  });

  testWidgets('open menu follows trigger while scroll position changes', (
    tester,
  ) async {
    final controller = ScrollController(initialScrollOffset: 120);

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            controller: controller,
            child: Column(
              children: [
                const SizedBox(height: 360),
                AppDropdownAnchor<void>(
                  width: 160,
                  height: 120,
                  targetAnchor: Alignment.bottomLeft,
                  followerAnchor: Alignment.topLeft,
                  offset: const Offset(0, 8),
                  builder: (context, toggle, isOpen) => ElevatedButton(
                    key: const ValueKey('scroll-trigger'),
                    onPressed: toggle,
                    child: const Text('滚动菜单'),
                  ),
                  menuBuilder: (context, close) => const Center(child: Text('滚动内容')),
                ),
                const SizedBox(height: 1200),
              ],
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.byKey(const ValueKey('scroll-trigger')));
    await tester.pump();
    await tester.pump();

    Rect triggerRect = tester.getRect(find.byKey(const ValueKey('scroll-trigger')));
    Rect menuRect = tester.getRect(find.byType(AppMenuPanel));
    expect(menuRect.top, closeTo(triggerRect.bottom + 8, 0.1));

    controller.jumpTo(220);
    await tester.pump();
    await tester.pump();

    triggerRect = tester.getRect(find.byKey(const ValueKey('scroll-trigger')));
    menuRect = tester.getRect(find.byType(AppMenuPanel));
    expect(menuRect.top, closeTo(triggerRect.bottom + 8, 0.1));
    expect(menuRect.left, closeTo(triggerRect.left, 0.1));
  });

  testWidgets('tap-positioned context menu stays fully visible near bottom right corner', (
    tester,
  ) async {
    await pumpContextMenu(
      tester,
      alignment: Alignment.bottomRight,
      useTapPosition: true,
    );

    final menuRect = tester.getRect(find.byType(AppMenuPanel));
    final viewWidth = tester.view.physicalSize.width / tester.view.devicePixelRatio;
    final viewHeight = tester.view.physicalSize.height / tester.view.devicePixelRatio;

    expect(menuRect.left, greaterThanOrEqualTo(11.9));
    expect(menuRect.top, greaterThanOrEqualTo(11.9));
    expect(menuRect.right, lessThanOrEqualTo(viewWidth - 11.9));
    expect(menuRect.bottom, lessThanOrEqualTo(viewHeight - 11.9));
  });

  testWidgets('anchored context menu opens above trigger and stays within viewport near corner', (
    tester,
  ) async {
    await pumpContextMenu(
      tester,
      alignment: Alignment.bottomRight,
      useTapPosition: false,
    );

    final triggerRect = tester.getRect(
      find.widgetWithText(ElevatedButton, '打开锚点菜单'),
    );
    final menuRect = tester.getRect(find.byType(AppMenuPanel));
    final viewWidth = tester.view.physicalSize.width / tester.view.devicePixelRatio;
    final viewHeight = tester.view.physicalSize.height / tester.view.devicePixelRatio;

    expect(menuRect.bottom, lessThanOrEqualTo(triggerRect.top - 7.9));
    expect(menuRect.left, greaterThanOrEqualTo(11.9));
    expect(menuRect.top, greaterThanOrEqualTo(11.9));
    expect(menuRect.right, lessThanOrEqualTo(viewWidth - 11.9));
    expect(menuRect.bottom, lessThanOrEqualTo(viewHeight - 11.9));
  });

  testWidgets('context menu blocks underlying scroll while open', (tester) async {
    final controller = ScrollController();
    final triggerKey = GlobalKey();

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SingleChildScrollView(
            controller: controller,
            child: Column(
              children: [
                const SizedBox(height: 240),
                Builder(
                  builder: (context) => ElevatedButton(
                    key: triggerKey,
                    onPressed: () => showAppContextMenu<void>(
                      context,
                      width: 180,
                      estimatedHeight: 120,
                      anchorContext: triggerKey.currentContext,
                      menuBuilder: (context, close) => Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: List.generate(
                          6,
                          (index) => AppMenuItemButton(
                            title: Text('菜单项 $index'),
                            onPressed: () => close(),
                          ),
                        ),
                      ),
                    ),
                    child: const Text('打开滚动阻止菜单'),
                  ),
                ),
                const SizedBox(height: 1600),
              ],
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.byKey(triggerKey));
    await tester.pump();
    await tester.pump();

    expect(find.byType(AppMenuPanel), findsOneWidget);
    expect(controller.offset, 0);

    await tester.dragFrom(const Offset(24, 24), const Offset(0, -240));
    await tester.pump();
    await tester.pump();

    expect(find.byType(AppMenuPanel), findsOneWidget);
    expect(controller.offset, 0);
  });

  testWidgets('context menu closes on escape key', (tester) async {
    await pumpContextMenu(
      tester,
      alignment: Alignment.center,
      useTapPosition: true,
    );

    expect(find.byType(AppMenuPanel), findsOneWidget);

    await tester.sendKeyDownEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    await tester.pump();

    expect(find.byType(AppMenuPanel), findsNothing);
  });

  testWidgets('opening a new context menu closes the previous one', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Row(
            mainAxisAlignment: MainAxisAlignment.spaceEvenly,
            children: [
              Builder(
                builder: (context) => ElevatedButton(
                  onPressed: () => showAppContextMenu<void>(
                    context,
                    width: 160,
                    estimatedHeight: 120,
                    tapPosition: const Offset(120, 160),
                    menuBuilder: (context, close) => const Text('第一个菜单'),
                  ),
                  child: const Text('打开菜单一'),
                ),
              ),
              Builder(
                builder: (context) => ElevatedButton(
                  onPressed: () => showAppContextMenu<void>(
                    context,
                    width: 160,
                    estimatedHeight: 120,
                    tapPosition: const Offset(280, 160),
                    menuBuilder: (context, close) => const Text('第二个菜单'),
                  ),
                  child: const Text('打开菜单二'),
                ),
              ),
            ],
          ),
        ),
      ),
    );

    final firstButton = tester.widget<ElevatedButton>(
      find.widgetWithText(ElevatedButton, '打开菜单一'),
    );
    firstButton.onPressed!.call();
    await tester.pump();
    await tester.pump();

    expect(find.text('第一个菜单'), findsOneWidget);
    expect(find.byType(AppMenuPanel), findsOneWidget);

    final secondButton = tester.widget<ElevatedButton>(
      find.widgetWithText(ElevatedButton, '打开菜单二'),
    );
    secondButton.onPressed!.call();
    await tester.pump();
    await tester.pump();

    expect(find.text('第一个菜单'), findsNothing);
    expect(find.text('第二个菜单'), findsOneWidget);
    expect(find.byType(AppMenuPanel), findsOneWidget);
  });

  testWidgets('context menu closes when navigation page changes', (
    tester,
  ) async {
    final navigation = NavigationProvider();

    await tester.pumpWidget(
      ChangeNotifierProvider<NavigationProvider>.value(
        value: navigation,
        child: MaterialApp(
          home: Scaffold(
            body: Builder(
              builder: (context) => ElevatedButton(
                onPressed: () => showAppContextMenu<void>(
                  context,
                  width: 160,
                  estimatedHeight: 120,
                  tapPosition: const Offset(180, 180),
                  menuBuilder: (context, close) => const Text('导航菜单'),
                ),
                child: const Text('打开导航菜单'),
              ),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.widgetWithText(ElevatedButton, '打开导航菜单'));
    await tester.pump();
    await tester.pump();

    expect(find.byType(AppMenuPanel), findsOneWidget);

    navigation.navigateToRoot(1);
    await tester.pump();
    await tester.pump();

    expect(find.byType(AppMenuPanel), findsNothing);
  });
}