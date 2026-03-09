import 'package:dio/dio.dart';

abstract class MusicTransport {
  Future<Response<dynamic>> get(
    String path, {
    Map<String, dynamic>? queryParameters,
    Options? options,
  });

  Future<void> ensureReady();

  Future<void> dispose();
}
