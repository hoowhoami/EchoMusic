import 'dart:async';
import 'dart:convert';
import 'dart:ffi';
import 'dart:isolate';

import 'package:ffi/ffi.dart';

import 'common.dart';
import 'core.dart';

abstract class LibraryMusicBridge {
  Map<String, String> get debugCookie;

  Future<void> setCookie(Map<String, String> cookie);

  Future<LibraryMusicResponse> request(
    String route, {
    Map<String, String>? cookie,
    KugouProcessEnv? env,
    Map<String, dynamic>? query,
  });

  Future<void> dispose();
}

class KugouMusicApiBridge implements LibraryMusicBridge {
  final EngineBindings _engine;
  final KugouBindings _bindings;
  late final KugouContextManager _contextManager;
  final KugouProcessEnv _env;
  late final KugouEnvHandle _nativeEnv;
  late final Pointer<JSContext> _ctx;
  Map<String, String> _cookie = {};

  bool _destroyed = false;

  KugouMusicApiBridge({KugouProcessEnv? env, String? libraryDir})
    : _engine = EngineBindings(libraryDir: libraryDir),
      _bindings = KugouBindings(libraryDir: libraryDir),
      _env = env ?? KugouProcessEnv() {
    _engine.ensureInitialized();

    _contextManager = KugouContextManager(bindings: _bindings);
    _nativeEnv = _env.toNative();
    _contextManager.init(_nativeEnv.pointer);
    _ctx = _contextManager.takeContext();
  }

  void setCookieSync(Map<String, String> cookie) {
    _cookie = cookie;
  }

  @override
  Future<void> setCookie(Map<String, String> cookie) async {
    setCookieSync(cookie);
  }

  @override
  Map<String, String> get debugCookie => Map<String, String>.from(_cookie);

  LibraryMusicResponse requestSync(
    String route, {
    Map<String, String>? cookie,
    KugouProcessEnv? env,
    Map<String, dynamic>? query,
  }) {
    if (_destroyed) {
      return LibraryMusicResponse.error('Bridge has been destroyed');
    }

    final useEnv = env ?? _env;
    final envHandle = identical(useEnv, _env) ? _nativeEnv : useEnv.toNative();
    final cookieJson = jsonEncode(cookie ?? _cookie);

    final routePtr = route.toNativeUtf8();
    final cookiePtr = cookieJson.toNativeUtf8();
    final paramsPtr = encodeQuery(
      query ?? const <String, dynamic>{},
    ).toNativeUtf8();

    try {
      final responsePtr = _bindings.request(
        _ctx,
        routePtr,
        cookiePtr,
        paramsPtr,
        envHandle.pointer,
      );

      return parseFfiResponse(responsePtr, _engine);
    } finally {
      calloc.free(routePtr);
      calloc.free(cookiePtr);
      calloc.free(paramsPtr);
      if (!identical(envHandle, _nativeEnv)) {
        envHandle.dispose();
      }
    }
  }

  @override
  Future<LibraryMusicResponse> request(
    String route, {
    Map<String, String>? cookie,
    KugouProcessEnv? env,
    Map<String, dynamic>? query,
  }) async {
    return requestSync(route, cookie: cookie, env: env, query: query);
  }

  void disposeSync() {
    if (_destroyed) {
      return;
    }

    _engine.destroyContext(_ctx);
    _contextManager.destroy();
    _nativeEnv.dispose();
    _engine.dispose();
    _destroyed = true;
  }

  @override
  Future<void> dispose() async {
    disposeSync();
  }
}

class IsolatedKugouMusicApiBridge implements LibraryMusicBridge {
  IsolatedKugouMusicApiBridge({KugouProcessEnv? env, String? libraryDir})
    : _env = env ?? KugouProcessEnv(),
      _libraryDir = libraryDir;

  final KugouProcessEnv _env;
  final String? _libraryDir;

  final Map<int, Completer<dynamic>> _pendingRequests =
      <int, Completer<dynamic>>{};

  Map<String, String> _cookie = const <String, String>{};
  SendPort? _workerPort;
  ReceivePort? _receivePort;
  Isolate? _workerIsolate;
  Completer<void>? _startCompleter;
  int _nextRequestId = 0;
  bool _disposed = false;

  @override
  Map<String, String> get debugCookie => Map<String, String>.from(_cookie);

  @override
  Future<void> setCookie(Map<String, String> cookie) async {
    _cookie = Map<String, String>.from(cookie);
    if (_workerPort == null) {
      return;
    }
    await _sendWorkerCommand(
      'set_cookie',
      payload: <String, dynamic>{'cookie': _cookie},
    );
  }

  @override
  Future<LibraryMusicResponse> request(
    String route, {
    Map<String, String>? cookie,
    KugouProcessEnv? env,
    Map<String, dynamic>? query,
  }) async {
    final dynamic response = await _sendWorkerCommand(
      'request',
      payload: <String, dynamic>{
        'route': route,
        'cookie': cookie,
        'env': env == null ? null : _serializeEnv(env),
        'query': Map<String, dynamic>.from(query ?? const <String, dynamic>{}),
      },
    );

    final responseMap = Map<String, dynamic>.from(response as Map);
    return LibraryMusicResponse(
      headers: Map<String, dynamic>.from(
        responseMap['headers'] as Map? ?? const <String, dynamic>{},
      ),
      body: Map<String, dynamic>.from(
        responseMap['body'] as Map? ?? const <String, dynamic>{},
      ),
      status: responseMap['status'] as int? ?? 500,
    );
  }

  @override
  Future<void> dispose() async {
    if (_disposed) {
      return;
    }

    final port = _workerPort;
    if (port != null) {
      try {
        await _sendWorkerCommand('dispose').timeout(const Duration(seconds: 1));
      } catch (_) {}
    }

    _disposed = true;

    for (final completer in _pendingRequests.values) {
      if (!completer.isCompleted) {
        completer.completeError(StateError('Bridge has been disposed'));
      }
    }
    _pendingRequests.clear();
    _receivePort?.close();
    _receivePort = null;
    _workerIsolate?.kill(priority: Isolate.immediate);
    _workerIsolate = null;
    _workerPort = null;
    _startCompleter = null;
  }

  Future<dynamic> _sendWorkerCommand(
    String type, {
    Map<String, dynamic>? payload,
  }) async {
    if (_disposed) {
      throw StateError('Bridge has been disposed');
    }

    await _ensureWorkerStarted();
    final port = _workerPort;
    if (port == null) {
      throw StateError('Bridge worker failed to start');
    }

    final requestId = _nextRequestId++;
    final completer = Completer<dynamic>();
    _pendingRequests[requestId] = completer;

    port.send(<String, dynamic>{'type': type, 'id': requestId, ...?payload});

    return completer.future;
  }

  Future<void> _ensureWorkerStarted() async {
    if (_workerPort != null) {
      return;
    }

    final existingStart = _startCompleter;
    if (existingStart != null) {
      await existingStart.future;
      return;
    }

    final completer = Completer<void>();
    _startCompleter = completer;
    final receivePort = ReceivePort();
    _receivePort = receivePort;
    receivePort.listen(_handleWorkerMessage);

    try {
      _workerIsolate = await Isolate.spawn<List<dynamic>>(
        _libraryBridgeWorkerMain,
        <dynamic>[
          receivePort.sendPort,
          _libraryDir,
          _serializeEnv(_env),
          _cookie,
        ],
      );
      await completer.future;
    } catch (e) {
      _receivePort?.close();
      _receivePort = null;
      _workerIsolate = null;
      _startCompleter = null;
      rethrow;
    }
  }

  void _handleWorkerMessage(dynamic message) {
    if (message is! Map) {
      return;
    }

    final type = message['type'];
    if (type == 'ready') {
      _workerPort = message['port'] as SendPort?;
      final startCompleter = _startCompleter;
      _startCompleter = null;
      if (startCompleter != null && !startCompleter.isCompleted) {
        startCompleter.complete();
      }
      return;
    }

    if (type == 'init_error') {
      final error = StateError(
        message['error']?.toString() ?? 'Bridge init failed',
      );
      final startCompleter = _startCompleter;
      _startCompleter = null;
      if (startCompleter != null && !startCompleter.isCompleted) {
        startCompleter.completeError(error);
      }
      return;
    }

    final requestId = message['id'] as int?;
    if (requestId == null) {
      return;
    }

    final completer = _pendingRequests.remove(requestId);
    if (completer == null || completer.isCompleted) {
      return;
    }

    final ok = message['ok'] == true;
    if (ok) {
      completer.complete(message['result']);
      return;
    }

    completer.completeError(
      StateError(
        message['error']?.toString() ?? 'Bridge worker request failed',
      ),
    );
  }
}

void _libraryBridgeWorkerMain(List<dynamic> config) {
  try {
    final rootSendPort = config[0] as SendPort;
    final libraryDir = config[1] as String?;
    final env = Map<String, dynamic>.from(config[2] as Map);
    final cookie = Map<String, String>.from(config[3] as Map);
    final bridge = KugouMusicApiBridge(
      env: _deserializeEnv(env),
      libraryDir: libraryDir,
    );
    bridge.setCookieSync(cookie);

    final receivePort = ReceivePort();
    rootSendPort.send(<String, dynamic>{
      'type': 'ready',
      'port': receivePort.sendPort,
    });

    receivePort.listen((dynamic message) {
      if (message is! Map) {
        return;
      }

      final requestId = message['id'] as int?;
      final type = message['type']?.toString();

      try {
        switch (type) {
          case 'set_cookie':
            bridge.setCookieSync(
              Map<String, String>.from(
                message['cookie'] as Map? ?? const <String, String>{},
              ),
            );
            rootSendPort.send(_workerSuccess(requestId, null));
            return;
          case 'request':
            final response = bridge.requestSync(
              message['route']?.toString() ?? '',
              cookie: message['cookie'] == null
                  ? null
                  : Map<String, String>.from(message['cookie'] as Map),
              env: message['env'] == null
                  ? null
                  : _deserializeEnv(
                      Map<String, dynamic>.from(message['env'] as Map),
                    ),
              query: Map<String, dynamic>.from(
                message['query'] as Map? ?? const <String, dynamic>{},
              ),
            );
            rootSendPort.send(
              _workerSuccess(requestId, <String, dynamic>{
                'headers': response.headers,
                'body': response.body,
                'status': response.status,
              }),
            );
            return;
          case 'dispose':
            bridge.disposeSync();
            rootSendPort.send(_workerSuccess(requestId, null));
            receivePort.close();
            return;
        }

        rootSendPort.send(
          _workerError(requestId, 'Unsupported worker command: $type'),
        );
      } catch (e) {
        rootSendPort.send(_workerError(requestId, e.toString()));
      }
    });
  } catch (e) {
    final rootSendPort = config[0] as SendPort;
    rootSendPort.send(<String, dynamic>{
      'type': 'init_error',
      'error': e.toString(),
    });
  }
}

Map<String, dynamic> _workerSuccess(int? id, dynamic result) {
  return <String, dynamic>{
    'type': 'response',
    'id': id,
    'ok': true,
    'result': result,
  };
}

Map<String, dynamic> _workerError(int? id, String error) {
  return <String, dynamic>{
    'type': 'response',
    'id': id,
    'ok': false,
    'error': error,
  };
}

Map<String, dynamic> _serializeEnv(KugouProcessEnv env) {
  return <String, dynamic>{
    'platform': env.platform.value,
    'guid': env.guid,
    'dev': env.dev,
    'mac': env.mac,
  };
}

KugouProcessEnv _deserializeEnv(Map<String, dynamic> env) {
  return KugouProcessEnv(
    platform: env['platform'] == KugouPlatform.lite.value
        ? KugouPlatform.lite
        : KugouPlatform.defaultValue,
    guid: env['guid']?.toString() ?? '',
    dev: env['dev']?.toString() ?? '',
    mac: env['mac']?.toString() ?? '',
  );
}
