import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:logger/logger.dart';
import 'package:path_provider/path_provider.dart';
import 'package:path/path.dart' as p;

class LoggerService {
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
      
      _logFile = File(p.join(logDir.path, 'app_log_${DateTime.now().toIso8601String().replaceAll(':', '-')}.log'));
      
      output = MultiOutput([
        ConsoleOutput(),
        FileOutput(file: _logFile!),
      ]);
    } else {
      // Development: Log to console with pretty printing
      output = ConsoleOutput();
    }

    _logger = Logger(
      filter: ProductionFilter(), // Show logs in release mode too if we use FileOutput
      printer: PrettyPrinter(
        methodCount: 0,
        errorMethodCount: 8,
        lineLength: 120,
        colors: !kReleaseMode,
        printEmojis: true,
        dateTimeFormat: DateTimeFormat.onlyTimeAndSinceStart,
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
