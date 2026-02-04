import 'dart:async';
import 'dart:ui';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:qr_flutter/qr_flutter.dart';
import '../../api/music_api.dart';
import '../../providers/user_provider.dart';
import '../../theme/app_theme.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key});

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  int _loginMethod = 0; // 0: QR, 1: Mobile
  
  // QR Login State
  String? qrKey;
  String? qrUrl;
  int qrStatus = 1;
  Timer? _timer;

  // Mobile Login State
  final _mobileController = TextEditingController();
  final _codeController = TextEditingController();
  bool _isSendingCode = false;
  int _countdown = 0;
  Timer? _countdownTimer;

  @override
  void initState() {
    super.initState();
    _loadQrCode();
  }

  @override
  void dispose() {
    _timer?.cancel();
    _countdownTimer?.cancel();
    _mobileController.dispose();
    _codeController.dispose();
    super.dispose();
  }

  Future<void> _loadQrCode() async {
    final res = await MusicApi.loginQrKey();
    if (res != null && res['key'] != null) {
      setState(() {
        qrKey = res['key'];
        qrStatus = 1;
      });
      
      final qrRes = await MusicApi.loginQrCreate(qrKey!);
      if (qrRes != null && qrRes['qrcode_url'] != null) {
        setState(() {
          qrUrl = qrRes['qrcode_url'];
        });
        _startCheckStatus();
      }
    }
  }

  void _startCheckStatus() {
    _timer?.cancel();
    _timer = Timer.periodic(const Duration(seconds: 3), (timer) async {
      if (qrKey == null || _loginMethod != 0) return;
      
      final res = await MusicApi.loginQrCheck(qrKey!);
      if (res != null) {
        final status = res['status'];
        setState(() {
          qrStatus = status;
        });

        if (status == 4) {
          _timer?.cancel();
          if (mounted) {
            final data = res['data'];
            if (data != null) {
              await context.read<UserProvider>().handleQrLoginSuccess(data);
              Navigator.of(context).pop();
            }
          }
        } else if (status == 0) {
          _timer?.cancel();
        }
      }
    });
  }

  Future<void> _sendCode() async {
    final mobile = _mobileController.text.trim();
    if (mobile.isEmpty) return;

    setState(() {
      _isSendingCode = true;
    });

    final success = await MusicApi.captchaSent(mobile);
    if (success) {
      setState(() {
        _countdown = 60;
      });
      _countdownTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
        setState(() {
          if (_countdown > 0) {
            _countdown--;
          } else {
            _countdownTimer?.cancel();
          }
        });
      });
    }

    setState(() {
      _isSendingCode = false;
    });
  }

  Future<void> _loginByMobile() async {
    final mobile = _mobileController.text.trim();
    final code = _codeController.text.trim();
    if (mobile.isEmpty || code.isEmpty) return;

    await context.read<UserProvider>().login(mobile, code);
    if (mounted && context.read<UserProvider>().isAuthenticated) {
      Navigator.of(context).pop();
    }
  }

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final accentColor = Theme.of(context).colorScheme.primary;

    return Scaffold(
      extendBodyBehindAppBar: true,
      appBar: AppBar(
        title: const Text('登录'),
        actions: [
          TextButton(
            onPressed: () {
              setState(() {
                _loginMethod = _loginMethod == 0 ? 1 : 0;
                if (_loginMethod == 0) _loadQrCode();
              });
            },
            child: Text(
              _loginMethod == 0 ? '验证码登录' : '扫码登录', 
              style: TextStyle(color: accentColor, fontWeight: FontWeight.bold)
            ),
          ),
          const SizedBox(width: 10),
        ],
      ),
      body: Stack(
        children: [
          // Background Gradient
          Positioned.fill(
            child: Container(
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: isDark 
                    ? [const Color(0xFF1E1E1E), const Color(0xFF000000), const Color(0xFF121212)]
                    : [const Color(0xFFF5F5F7), const Color(0xFFFFFFFF), const Color(0xFFE5E5EA)],
                ),
              ),
            ),
          ),
          Center(
            child: BackdropFilter(
              filter: ImageFilter.blur(sigmaX: 20, sigmaY: 20),
              child: Container(
                width: 400,
                padding: const EdgeInsets.all(40),
                decoration: BoxDecoration(
                  color: isDark ? Colors.white.withAlpha(15) : Colors.black.withAlpha(5),
                  borderRadius: BorderRadius.circular(24),
                  border: Border.all(color: isDark ? Colors.white.withAlpha(20) : Colors.black.withAlpha(10)),
                ),
                child: SingleChildScrollView(
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      if (_loginMethod == 0) _buildQrLogin(context) else _buildMobileLogin(context),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildQrLogin(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final textColor = isDark ? Colors.white : Colors.black87;

    return Column(
      children: [
        Text(
          '扫码登录', 
          style: TextStyle(fontSize: 24, fontWeight: FontWeight.w800, color: textColor, letterSpacing: -0.5)
        ),
        const SizedBox(height: 8),
        Text(
          '使用酷狗音乐APP扫码', 
          style: TextStyle(fontSize: 14, color: isDark ? Colors.white54 : Colors.black54)
        ),
        const SizedBox(height: 32),
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: Colors.white, 
            borderRadius: BorderRadius.circular(16),
            boxShadow: [
              BoxShadow(color: Colors.black.withAlpha(20), blurRadius: 20, offset: const Offset(0, 10))
            ]
          ),
          child: qrUrl != null
              ? Stack(
                  alignment: Alignment.center,
                  children: [
                    QrImageView(data: qrUrl!, version: QrVersions.auto, size: 200.0),
                    if (qrStatus == 0)
                      Container(
                        color: Colors.white.withAlpha(200),
                        width: 200, height: 200,
                        child: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            const Text('二维码已过期', style: TextStyle(color: Colors.black, fontWeight: FontWeight.bold)),
                            TextButton(onPressed: _loadQrCode, child: const Text('点击刷新')),
                          ],
                        ),
                      ),
                    if (qrStatus == 2)
                      Container(
                        color: Colors.white.withAlpha(200),
                        width: 200, height: 200,
                        child: const Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            Icon(Icons.check_circle, color: Colors.green, size: 48),
                            SizedBox(height: 12),
                            Text('已扫码，请在手机上确认', style: TextStyle(color: Colors.black, fontSize: 13, fontWeight: FontWeight.w600)),
                          ],
                        ),
                      ),
                  ],
                )
              : const SizedBox(width: 200, height: 200, child: Center(child: CircularProgressIndicator())),
        ),
        const SizedBox(height: 32),
        Text(_getStatusText(), style: TextStyle(color: isDark ? Colors.white38 : Colors.black38, fontSize: 13)),
      ],
    );
  }

  Widget _buildMobileLogin(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final textColor = isDark ? Colors.white : Colors.black87;
    final accentColor = Theme.of(context).colorScheme.primary;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          '验证码登录', 
          style: TextStyle(fontSize: 24, fontWeight: FontWeight.w800, color: textColor, letterSpacing: -0.5)
        ),
        const SizedBox(height: 32),
        TextField(
          controller: _mobileController,
          keyboardType: TextInputType.phone,
          style: TextStyle(color: textColor),
          decoration: InputDecoration(
            hintText: '手机号码',
            hintStyle: TextStyle(color: isDark ? Colors.white30 : Colors.black38),
            prefixIcon: Icon(Icons.phone_android, color: isDark ? Colors.white30 : Colors.black38, size: 20),
            filled: true,
            fillColor: isDark ? Colors.white.withAlpha(10) : Colors.black.withAlpha(5),
            border: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide.none),
            contentPadding: const EdgeInsets.symmetric(vertical: 16),
          ),
        ),
        const SizedBox(height: 16),
        Row(
          children: [
            Expanded(
              child: TextField(
                controller: _codeController,
                keyboardType: TextInputType.number,
                style: TextStyle(color: textColor),
                decoration: InputDecoration(
                  hintText: '验证码',
                  hintStyle: TextStyle(color: isDark ? Colors.white30 : Colors.black38),
                  prefixIcon: Icon(Icons.lock_outline, color: isDark ? Colors.white30 : Colors.black38, size: 20),
                  filled: true,
                  fillColor: isDark ? Colors.white.withAlpha(10) : Colors.black.withAlpha(5),
                  border: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: BorderSide.none),
                  contentPadding: const EdgeInsets.symmetric(vertical: 16),
                ),
              ),
            ),
            const SizedBox(width: 12),
            SizedBox(
              height: 52,
              child: ElevatedButton(
                onPressed: _countdown > 0 || _isSendingCode ? null : _sendCode,
                style: ElevatedButton.styleFrom(
                  backgroundColor: accentColor,
                  foregroundColor: Colors.white,
                  elevation: 0,
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                ),
                child: Text(_countdown > 0 ? '${_countdown}s' : '获取验证码', style: const TextStyle(fontWeight: FontWeight.bold)),
              ),
            ),
          ],
        ),
        const SizedBox(height: 32),
        SizedBox(
          width: double.infinity,
          height: 52,
          child: ElevatedButton(
            onPressed: _loginByMobile,
            style: ElevatedButton.styleFrom(
              backgroundColor: textColor,
              foregroundColor: isDark ? Colors.black : Colors.white,
              elevation: 0,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
            ),
            child: const Text('立即登录', style: TextStyle(fontSize: 16, fontWeight: FontWeight.bold)),
          ),
        ),
      ],
    );
  }

  String _getStatusText() {
    switch (qrStatus) {
      case 1: return '等待扫码...';
      case 2: return '待确认...';
      case 4: return '登录成功';
      case 0: return '二维码已过期';
      default: return '';
    }
  }
}