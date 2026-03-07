import 'dart:io';

import 'package:echomusic/utils/logger.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('LoggerService builds prefixed log file names', () {
    final fileName = LoggerService.buildLogFileName(
      DateTime.parse('2026-03-07T12:34:56.000'),
    );

    expect(fileName, startsWith('echomusic_app_log_'));
    expect(fileName, endsWith('.log'));
    expect(fileName, isNot(contains(':')));
  });

  test('LoggerService cleans only expired managed log files', () async {
    final logDir = await Directory.systemTemp.createTemp('echomusic_logger_test_');
    final now = DateTime.parse('2026-03-07T12:00:00.000');

    Future<File> createFile(String name, DateTime modifiedAt) async {
      final file = File('${logDir.path}/$name');
      await file.writeAsString(name);
      await file.setLastModified(modifiedAt);
      return file;
    }

    final expiredManaged = await createFile(
      'echomusic_app_log_old.log',
      now.subtract(const Duration(days: 4)),
    );
    final expiredLegacy = await createFile(
      'app_log_old.log',
      now.subtract(const Duration(days: 4)),
    );
    final recentManaged = await createFile(
      'echomusic_app_log_recent.log',
      now.subtract(const Duration(days: 2)),
    );
    final unrelatedFile = await createFile(
      'other_file.log',
      now.subtract(const Duration(days: 10)),
    );

    try {
      await LoggerService.cleanupExpiredLogsForTesting(logDir, now: now);

      expect(await expiredManaged.exists(), isFalse);
      expect(await expiredLegacy.exists(), isFalse);
      expect(await recentManaged.exists(), isTrue);
      expect(await unrelatedFile.exists(), isTrue);
    } finally {
      if (await logDir.exists()) {
        await logDir.delete(recursive: true);
      }
    }
  });
}