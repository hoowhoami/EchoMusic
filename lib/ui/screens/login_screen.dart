import 'dart:async';
import 'dart:convert';
import 'dart:ui';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:qr_flutter/qr_flutter.dart';
import '../../api/music_api.dart';
import '../../providers/user_provider.dart';

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
  bool _isLoadingQr = false;
  String? _errorMessage;

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
    setState(() {
      _isLoadingQr = true;
      _errorMessage = null;
      qrUrl = null;
    });

    try {
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
            _isLoadingQr = false;
          });
          _startCheckStatus();
        } else {
          setState(() {
            _errorMessage = '生成二维码失败，请重试';
            _isLoadingQr = false;
          });
        }
      } else {
        setState(() {
          _errorMessage = '获取二维码Key失败，请重试';
          _isLoadingQr = false;
        });
      }
    } catch (e) {
      debugPrint('Load QR error: $e');
      setState(() {
        _errorMessage = '网络错误: $e';
        _isLoadingQr = false;
      });
    }
  }

  void _startCheckStatus() {
    _timer?.cancel();
    _timer = Timer.periodic(const Duration(seconds: 3), (timer) async {
      if (qrKey == null || _loginMethod != 0) return;

      final res = await MusicApi.loginQrCheck(qrKey!);
      if (res != null) {
        // 从嵌套的 data 中获取实际状态
        final status = res['data']?['status'] ?? res['status'];
        debugPrint('QR status: $status, full response: $res');

        setState(() {
          qrStatus = status;
        });

        if (status == 4) {
          _timer?.cancel();
          if (mounted) {
            final data = res['data'];
            if (data != null) {
              // 在 async 操作后再次检查 mounted
              if (!mounted) return;
              await context.read<UserProvider>().handleQrLoginSuccess(data);
              if (!mounted) return;
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
    final theme = Theme.of(context);
    final accentColor = theme.colorScheme.primary;

    return Scaffold(
      body: Stack(
        children: [
          // 1. Background Gradient
          Positioned.fill(
            child: Container(
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: [
                    theme.scaffoldBackgroundColor,
                    theme.colorScheme.surface,
                    theme.colorScheme.surfaceContainerHighest.withAlpha(150),
                  ],
                ),
              ),
            ),
          ),
          
          // 2. Main Content
          SafeArea(
            child: Center(
              child: BackdropFilter(
                filter: ImageFilter.blur(sigmaX: 30, sigmaY: 30),
                child: Container(
                  width: 400,
                  padding: const EdgeInsets.all(40),
                  decoration: BoxDecoration(
                    color: theme.colorScheme.surface.withAlpha(180),
                    borderRadius: BorderRadius.circular(24),
                    border: Border.all(color: theme.colorScheme.outlineVariant),
                    boxShadow: [
                      BoxShadow(
                        color: theme.colorScheme.shadow.withAlpha(50),
                        blurRadius: 40,
                        offset: const Offset(0, 20),
                      ),
                    ],
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
          ),

          // 3. Custom Top Bar (Last child to be on top of everything)
          Positioned(
            top: 0,
            left: 0,
            right: 0,
            height: 100,
            child: Padding(
              padding: const EdgeInsets.only(top: 40, left: 20, right: 20),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.center,
                children: [
                  // Back Button (Now positioned below the macOS traffic lights area)
                  Material(
                    color: Colors.transparent,
                    child: IconButton(
                      icon: Icon(Icons.arrow_back_ios_new_rounded, size: 20, color: theme.colorScheme.onSurface),
                      onPressed: () => Navigator.of(context).pop(),
                      tooltip: '返回',
                    ),
                  ),
                  
                  const Spacer(),
                  
                  // Login Method Switcher
                  Material(
                    color: Colors.transparent,
                    child: TextButton(
                      onPressed: () {
                        setState(() {
                          _loginMethod = _loginMethod == 0 ? 1 : 0;
                          if (_loginMethod == 0) _loadQrCode();
                        });
                      },
                      child: Text(
                        _loginMethod == 0 ? '验证码登录' : '扫码登录', 
                        style: TextStyle(
                          color: accentColor, 
                          fontWeight: FontWeight.w800,
                          fontSize: 15,
                        )
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildQrLogin(BuildContext context) {
    final theme = Theme.of(context);
    final textColor = theme.colorScheme.onSurface;

    return Column(
      children: [
        Text(
          '扫码登录', 
          style: TextStyle(fontSize: 24, fontWeight: FontWeight.w800, color: textColor, letterSpacing: -0.8)
        ),
        const SizedBox(height: 8),
        Text(
          '使用酷狗音乐APP扫码', 
          style: TextStyle(fontSize: 14, color: theme.colorScheme.onSurfaceVariant, fontWeight: FontWeight.w600)
        ),
        const SizedBox(height: 32),
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.circular(16),
            boxShadow: [
              BoxShadow(color: Colors.black.withAlpha(30), blurRadius: 25, offset: const Offset(0, 10))
            ]
          ),
          child: qrUrl != null
              ? Stack(
                  alignment: Alignment.center,
                  children: [
                    // 检查是否是 base64 图片数据
                    qrUrl!.startsWith('data:image')
                        ? Image.memory(
                            base64Decode(qrUrl!.split(',').last),
                            width: 200,
                            height: 200,
                            fit: BoxFit.contain,
                            errorBuilder: (context, error, stackTrace) {
                              return const Icon(Icons.error, size: 48, color: Colors.red);
                            },
                          )
                        : QrImageView(data: qrUrl!, version: QrVersions.auto, size: 200.0),
                    if (qrStatus == 0)
                      Container(
                        color: Colors.white.withAlpha(220),
                        width: 200, height: 200,
                        child: Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            const Text('二维码已过期', style: TextStyle(color: Colors.black, fontWeight: FontWeight.w800)),
                            TextButton(onPressed: _loadQrCode, child: const Text('点击刷新', style: TextStyle(fontWeight: FontWeight.w800))),
                          ],
                        ),
                      ),
                    if (qrStatus == 2)
                      Container(
                        color: Colors.white.withAlpha(220),
                        width: 200, height: 200,
                        child: const Column(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            Icon(Icons.check_circle, color: Colors.green, size: 56),
                            SizedBox(height: 16),
                            Text('已扫码，请在手机上确认', style: TextStyle(color: Colors.black, fontSize: 13, fontWeight: FontWeight.w800)),
                          ],
                        ),
                      ),
                  ],
                )
              : _isLoadingQr
                  ? const SizedBox(width: 200, height: 200, child: Center(child: CircularProgressIndicator()))
                  : SizedBox(
                      width: 200, height: 200,
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          const Icon(Icons.error_outline, size: 48, color: Colors.red),
                          SizedBox(height: 12),
                          Text(_errorMessage ?? '加载失败', style: const TextStyle(color: Colors.black, fontSize: 12, fontWeight: FontWeight.w600)),
                          SizedBox(height: 8),
                          TextButton(
                            onPressed: _loadQrCode,
                            child: const Text('重试', style: TextStyle(fontWeight: FontWeight.w800)),
                          ),
                        ],
                      ),
                    ),
        ),
        const SizedBox(height: 32),
        Text(_getStatusText(), style: TextStyle(color: theme.colorScheme.onSurfaceVariant, fontSize: 13, fontWeight: FontWeight.w600)),
      ],
    );
  }

  Widget _buildMobileLogin(BuildContext context) {
    final theme = Theme.of(context);
    final textColor = theme.colorScheme.onSurface;
    final accentColor = theme.colorScheme.primary;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          '验证码登录', 
          style: TextStyle(fontSize: 24, fontWeight: FontWeight.w800, color: textColor, letterSpacing: -0.8)
        ),
        const SizedBox(height: 32),
        TextField(
          controller: _mobileController,
          keyboardType: TextInputType.phone,
          style: TextStyle(color: textColor, fontWeight: FontWeight.w600),
          decoration: InputDecoration(
            hintText: '手机号码',
            hintStyle: TextStyle(color: theme.colorScheme.onSurfaceVariant.withAlpha(150)),
            prefixIcon: Icon(Icons.phone_android, color: theme.colorScheme.onSurfaceVariant, size: 20),
            filled: true,
            fillColor: theme.colorScheme.onSurface.withAlpha(8),
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
                style: TextStyle(color: textColor, fontWeight: FontWeight.w600),
                decoration: InputDecoration(
                  hintText: '验证码',
                  hintStyle: TextStyle(color: theme.colorScheme.onSurfaceVariant.withAlpha(150)),
                  prefixIcon: Icon(Icons.lock_outline, color: theme.colorScheme.onSurfaceVariant, size: 20),
                  filled: true,
                  fillColor: theme.colorScheme.onSurface.withAlpha(8),
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
                child: Text(_countdown > 0 ? '${_countdown}s' : '获取验证码', style: const TextStyle(fontWeight: FontWeight.w800)),
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
              backgroundColor: theme.colorScheme.onSurface,
              foregroundColor: theme.colorScheme.surface,
              elevation: 0,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
            ),
            child: const Text('立即登录', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w800)),
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
