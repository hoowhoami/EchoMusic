import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:logger/logger.dart';
import 'package:path_provider/path_provider.dart';
import 'package:path/path.dart' as p;

class LoggerService {
  static const String _logFilePrefix = 'echomusic_app_log_';
  static const List<String> _managedLogFilePrefixes = [
    _logFilePrefix,
    'app_log_',
  ];
  static const Duration _logRetention = Duration(days: 3);

  static late Logger _logger;
  static File? _logFile;

  static Future<void> init() async {
    LogOutput output;
    
    if (kReleaseMode) {
      // Production: Log to file and console (optionally console if needed for debugging release)
      final directory = await getApplicationDocumentsDirectory();
      final logDir = Directory(p.join(directory.path, 'logs'));
      if (!await logDir.exists()) {
        await logDir.create(recursive: true);
      }

      await _cleanupExpiredLogs(logDir);
      
      _logFile = File(
        p.join(
          logDir.path,
          buildLogFileName(DateTime.now()),
        ),
      );
      
      output = MultiOutput([
        ConsoleOutput(),
        FileOutput(file: _logFile!),
      ]);
    } else {
      // Development: Log to console with pretty printing
      output = ConsoleOutput();
    }

    _logger = Logger(
      filter: ProductionFilter(),
      printer: PrettyPrinter(
        methodCount: 0,
        errorMethodCount: 8,
        lineLength: 120,
        colors: !kReleaseMode,
        printEmojis: true,
        dateTimeFormat: DateTimeFormat.onlyTimeAndSinceStart,
        noBoxingByDefault: true,
      ),
      output: output,
    );
  }

  static void d(dynamic message, [dynamic error, StackTrace? stackTrace]) {
    _logger.d(message, error: error, stackTrace: stackTrace);
  }

  static void i(dynamic message, [dynamic error, StackTrace? stackTrace]) {
    _logger.i(message, error: error, stackTrace: stackTrace);
  }

  static void w(dynamic message, [dynamic error, StackTrace? stackTrace]) {
    _logger.w(message, error: error, stackTrace: stackTrace);
  }

  static void e(dynamic message, [dynamic error, StackTrace? stackTrace]) {
    _logger.e(message, error: error, stackTrace: stackTrace);
  }

  static void f(dynamic message, [dynamic error, StackTrace? stackTrace]) {
    _logger.f(message, error: error, stackTrace: stackTrace);
  }

  @visibleForTesting
  static String buildLogFileName(DateTime timestamp) {
    return '$_logFilePrefix${timestamp.toIso8601String().replaceAll(':', '-')}.log';
  }

  @visibleForTesting
  static Future<void> cleanupExpiredLogsForTesting(
    Directory logDir, {
    DateTime? now,
  }) {
    return _cleanupExpiredLogs(logDir, now: now);
  }

  static Future<void> _cleanupExpiredLogs(
    Directory logDir, {
    DateTime? now,
  }) async {
    final cutoff = (now ?? DateTime.now()).subtract(_logRetention);

    await for (final entity in logDir.list(followLinks: false)) {
      if (entity is! File) continue;

      final fileName = p.basename(entity.path);
      final isManagedLog = _managedLogFilePrefixes.any(fileName.startsWith);
      if (!isManagedLog) continue;

      try {
        final stat = await entity.stat();
        if (stat.modified.isBefore(cutoff)) {
          await entity.delete();
        }
      } catch (_) {}
    }
  }
  
  static File? get logFile => _logFile;
}

class FileOutput extends LogOutput {
  final File file;
  final bool overrideExisting;

  FileOutput({
    required this.file,
    this.overrideExisting = false,
  });

  @override
  Future<void> init() async {
    if (overrideExisting && file.existsSync()) {
      file.deleteSync();
    }
  }

  @override
  void output(OutputEvent event) {
    for (var line in event.lines) {
      file.writeAsStringSync(
        '$line\n',
        mode: FileMode.writeOnlyAppend,
        flush: true,
      );
    }
  }
}
