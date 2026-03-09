import 'package:dio/dio.dart';

import '../music_api_auth.dart';
import '../../utils/logger.dart';
import '../../utils/server_orchestrator.dart';
import 'music_transport.dart';

typedef MusicTransportAuthExpirationHandler =
    void Function(String path, dynamic data);
typedef MusicTransportDataFormatter = String Function(dynamic data);

class HttpMusicTransport implements MusicTransport {
  HttpMusicTransport({
    required MusicTransportAuthExpirationHandler authExpirationHandler,
    required MusicTransportDataFormatter dataFormatter,
  }) : _authExpirationHandler = authExpirationHandler,
       _dataFormatter = dataFormatter,
       _dio = Dio(
         BaseOptions(
           baseUrl: 'http://127.0.0.1:10086',
           connectTimeout: const Duration(seconds: 10),
           receiveTimeout: const Duration(seconds: 10),
         ),
       ) {
    _dio.interceptors.add(
      InterceptorsWrapper(
        onRequest: (options, handler) async {
          options.extra['startTime'] = DateTime.now().millisecondsSinceEpoch;

          if (options.extra['skipAuth'] == true) {
            options.queryParameters['t'] =
                DateTime.now().millisecondsSinceEpoch;
            return handler.next(options);
          }

          final authCookie = await MusicApiStoredAuth.loadCookieValue();

          if (authCookie != null && authCookie.isNotEmpty) {
            options.headers['Authorization'] = authCookie;
          }

          options.queryParameters['t'] = DateTime.now().millisecondsSinceEpoch;

          return handler.next(options);
        },
        onResponse: (response, handler) {
          _authExpirationHandler(response.requestOptions.path, response.data);

          final startTime = response.requestOptions.extra['startTime'] as int?;
          final endTime = DateTime.now().millisecondsSinceEpoch;
          final duration = startTime != null ? endTime - startTime : null;

          final logMsg = StringBuffer();
          logMsg.writeln(
            'HTTP [${response.requestOptions.method}] ${response.requestOptions.uri}',
          );
          logMsg.writeln(
            'Status: ${response.statusCode} ${response.statusMessage} | Duration: ${duration}ms',
          );
          logMsg.writeln('Headers: ${response.requestOptions.headers}');
          if (response.requestOptions.data != null) {
            logMsg.writeln('Request Body: ${response.requestOptions.data}');
          }
          logMsg.write('Response: ${_dataFormatter(response.data)}');

          LoggerService.i(logMsg.toString());

          return handler.next(response);
        },
        onError: (err, handler) {
          if (err.response != null) {
            _authExpirationHandler(err.requestOptions.path, err.response!.data);
          }

          final startTime = err.requestOptions.extra['startTime'] as int?;
          final endTime = DateTime.now().millisecondsSinceEpoch;
          final duration = startTime != null ? endTime - startTime : null;

          final logMsg = StringBuffer();
          logMsg.writeln(
            'HTTP Error [${err.requestOptions.method}] ${err.requestOptions.uri}',
          );
          logMsg.writeln(
            'Status: ${err.response?.statusCode} | Duration: ${duration}ms',
          );
          logMsg.writeln('Headers: ${err.requestOptions.headers}');
          logMsg.writeln('Error: ${err.message}');
          if (err.requestOptions.data != null) {
            logMsg.writeln('Request Body: ${err.requestOptions.data}');
          }
          if (err.response?.data != null) {
            logMsg.write('Response: ${_dataFormatter(err.response?.data)}');
          }

          LoggerService.e(logMsg.toString());

          return handler.next(err);
        },
      ),
    );
  }

  final MusicTransportAuthExpirationHandler _authExpirationHandler;
  final MusicTransportDataFormatter _dataFormatter;
  final Dio _dio;

  @override
  Future<Response<dynamic>> get(
    String path, {
    Map<String, dynamic>? queryParameters,
    Options? options,
  }) async {
    await ensureReady();
    return _dio.get(path, queryParameters: queryParameters, options: options);
  }

  @override
  Future<void> ensureReady() async {
    await ServerOrchestrator.waitUntilReady();
  }

  @override
  Future<void> dispose() async {
    _dio.close(force: true);
  }
}
