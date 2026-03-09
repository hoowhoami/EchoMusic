import 'package:dio/dio.dart';

import '../../utils/logger.dart';
import '../../utils/music_server_runtime.dart';
import '../backend/library/kugou_bridge.dart';
import 'music_transport.dart';

typedef LibraryTransportAuthExpirationHandler =
    void Function(String path, dynamic data);
typedef LibraryTransportDataFormatter = String Function(dynamic data);

class LibraryMusicTransport implements MusicTransport {
  LibraryMusicTransport({
    required LibraryMusicBridge Function() bridgeProvider,
    LibraryTransportAuthExpirationHandler? authExpirationHandler,
    LibraryTransportDataFormatter? dataFormatter,
    Future<void> Function()? readyEnsurer,
  }) : _bridgeProvider = bridgeProvider,
       _authExpirationHandler = authExpirationHandler,
       _dataFormatter = dataFormatter,
       _readyEnsurer = readyEnsurer;

  final LibraryMusicBridge Function() _bridgeProvider;
  final LibraryTransportAuthExpirationHandler? _authExpirationHandler;
  final LibraryTransportDataFormatter? _dataFormatter;
  final Future<void> Function()? _readyEnsurer;

  @override
  Future<Response<dynamic>> get(
    String path, {
    Map<String, dynamic>? queryParameters,
    Options? options,
  }) async {
    final requestOptions = RequestOptions(
      path: path,
      method: 'GET',
      queryParameters: queryParameters ?? const <String, dynamic>{},
      headers: Map<String, dynamic>.from(options?.headers ?? const {}),
      extra: Map<String, dynamic>.from(options?.extra ?? const {}),
    );

    try {
      await ensureReady();
    } catch (e) {
      return Response<dynamic>(
        requestOptions: requestOptions,
        data: {'status': 0, 'error': e.toString()},
        statusCode: 503,
        statusMessage: 'Runtime Not Ready',
      );
    }

    final startTime = DateTime.now().millisecondsSinceEpoch;
    final extra = options?.extra ?? const <String, dynamic>{};
    final response = await _bridgeProvider().request(
      path,
      cookie: extra['skipAuth'] == true ? const <String, String>{} : null,
      query: queryParameters,
    );

    final dioResponse = Response<dynamic>(
      requestOptions: requestOptions,
      data: response.data,
      statusCode: response.status,
      statusMessage: response.isSuccess ? 'OK' : 'Error',
      headers: Headers.fromMap(
        response.headers.map(
          (key, value) => MapEntry(key, [value?.toString() ?? '']),
        ),
      ),
    );

    _authExpirationHandler?.call(path, response.data);
    _logResponse(requestOptions, dioResponse, startTime);

    if (!response.isSuccess) {
      throw DioException.badResponse(
        statusCode: response.status,
        requestOptions: requestOptions,
        response: dioResponse,
      );
    }

    return dioResponse;
  }

  void _logResponse(
    RequestOptions requestOptions,
    Response<dynamic> response,
    int startTime,
  ) {
    final duration = DateTime.now().millisecondsSinceEpoch - startTime;
    final formatter = _dataFormatter;
    final formattedData = formatter != null
        ? formatter(response.data)
        : response.data.toString();
    LoggerService.i(
      'LIBRARY [${requestOptions.method}] ${requestOptions.path} '
      'Status: ${response.statusCode} | Duration: ${duration}ms '
      'Query: ${requestOptions.queryParameters} Response: $formattedData',
    );
  }

  @override
  Future<void> ensureReady() async {
    final readyEnsurer = _readyEnsurer;
    if (readyEnsurer != null) {
      await readyEnsurer();
      return;
    }
    final ready = await MusicServerRuntimeController.ensureReady();
    if (!ready) {
      final reason =
          MusicServerRuntimeController.lastError ??
          'Library runtime is not ready';
      throw StateError(reason);
    }
  }

  @override
  Future<void> dispose() async {}
}
