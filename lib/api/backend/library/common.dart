import 'dart:convert';

class LibraryMusicResponse {
  LibraryMusicResponse({
    required this.headers,
    required this.body,
    required this.status,
  });

  factory LibraryMusicResponse.fromJsonString(String responseJson) {
    final dynamic decoded = jsonDecode(responseJson);
    if (decoded is! Map<String, dynamic>) {
      return LibraryMusicResponse.error('Response is not a JSON object');
    }

    final headers = decoded['headers'];
    final body = decoded['body'];
    final status = decoded['status'];

    return LibraryMusicResponse(
      headers: headers is Map
          ? Map<String, dynamic>.from(headers)
          : <String, dynamic>{},
      body: body is Map ? Map<String, dynamic>.from(body) : <String, dynamic>{},
      status: status is int ? status : 500,
    );
  }

  factory LibraryMusicResponse.error(String message) {
    return LibraryMusicResponse(
      headers: const <String, dynamic>{},
      body: <String, dynamic>{'error': message},
      status: 500,
    );
  }

  final Map<String, dynamic> headers;
  final Map<String, dynamic> body;
  final int status;

  Map<String, dynamic> get data => body;

  String get cookies {
    final cookie = headers['Set-Cookie'];
    return cookie?.toString() ?? '';
  }

  bool get isSuccess => status >= 200 && status < 300;

  @override
  String toString() {
    final prettyHeaders = const JsonEncoder.withIndent('  ').convert(headers);
    final prettyBody = const JsonEncoder.withIndent('  ').convert(body);
    return 'LibraryMusicResponse(\n'
        '  status: $status\n'
        '  headers:\n$prettyHeaders\n'
        '  body:\n$prettyBody\n'
        ')';
  }
}
