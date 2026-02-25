import 'dart:async';
import 'dart:convert';
import 'dart:ui';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'package:qr_flutter/qr_flutter.dart';
import '../../api/music_api.dart';
import '../../providers/user_provider.dart';
import '../../theme/app_theme.dart';
import '../widgets/custom_toast.dart';

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
  String? _mobileError;
  String? _codeError;
  bool _isSendingCode = false;
  int _countdown = 0;
  Timer? _countdownTimer;

  // Account Selection State
  bool _showAccountSelection = false;
  List<dynamic> _accountList = [];
  bool _isLoggingIn = false;

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
    if (mobile.isEmpty) {
      setState(() => _mobileError = '请输入手机号码');
      return;
    }
    if (mobile.length != 11) {
      setState(() => _mobileError = '请输入正确的11位手机号码');
      return;
    }

    setState(() {
      _isSendingCode = true;
      _mobileError = null;
    });

    final success = await MusicApi.captchaSent(mobile);
    if (success) {
      if (mounted) CustomToast.success(context, '验证码已发送');
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
    } else {
      setState(() => _mobileError = '发送失败，请重试');
    }

    setState(() {
      _isSendingCode = false;
    });
  }

  Future<void> _loginByMobile({int? selectedUserId}) async {
    final mobile = _mobileController.text.trim();
    final code = _codeController.text.trim();
    
    if (selectedUserId == null) {
      setState(() {
        _mobileError = mobile.isEmpty ? '请输入手机号码' : (mobile.length != 11 ? '请输入正确的11位手机号码' : null);
        _codeError = code.isEmpty ? '请输入验证码' : null;
      });
      if (_mobileError != null || _codeError != null) return;
    }

    setState(() => _isLoggingIn = true);

    try {
      final response = await context.read<UserProvider>().login(
        mobile, 
        code, 
        userid: selectedUserId
      );

      if (mounted) {
        if (response['status'] == 1) {
          CustomToast.success(context, '登录成功');
          Navigator.of(context).pop();
        } else {
          // Handle multi-account or other errors
          final data = response['data'];
          if (data != null && data['info_list'] != null && selectedUserId == null) {
            setState(() {
              _accountList = data['info_list'];
              _showAccountSelection = true;
            });
          } else {
            final errorMsg = response['error'] ?? response['msg'] ?? '登录失败，请检查验证码';
            CustomToast.error(context, errorMsg.toString());
            setState(() => _codeError = errorMsg.toString());
          }
        }
      }
    } catch (e) {
      if (mounted) CustomToast.error(context, '系统错误: $e');
    } finally {
      if (mounted) setState(() => _isLoggingIn = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final modernTheme = theme.extension<AppModernTheme>()!;
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
                  constraints: const BoxConstraints(maxHeight: 600),
                  padding: const EdgeInsets.all(40),
                  decoration: BoxDecoration(
                    color: modernTheme.modalColor,
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
                        if (_showAccountSelection)
                          _buildAccountSelection(context)
                        else if (_loginMethod == 0)
                          _buildQrLogin(context)
                        else
                          _buildMobileLogin(context),
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
                      onPressed: () {
                        if (_showAccountSelection) {
                          setState(() => _showAccountSelection = false);
                        } else {
                          Navigator.of(context).pop();
                        }
                      },
                      tooltip: '返回',
                    ),
                  ),
                  
                  const Spacer(),
                  
                  // Login Method Switcher
                  if (!_showAccountSelection)
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

  Widget _buildAccountSelection(BuildContext context) {
    final theme = Theme.of(context);
    final accentColor = theme.colorScheme.primary;

    return Column(
      children: [
        Text(
          '多账号选择', 
          style: TextStyle(fontSize: 22, fontWeight: FontWeight.w900, color: theme.colorScheme.onSurface, letterSpacing: -0.8)
        ),
        const SizedBox(height: 8),
        Text(
          '该手机绑定多个账号，请选择一个登录', 
          style: TextStyle(fontSize: 13, color: theme.colorScheme.onSurfaceVariant, fontWeight: FontWeight.w600)
        ),
        const SizedBox(height: 24),
        ConstrainedBox(
          constraints: const BoxConstraints(maxHeight: 300),
          child: ListView.separated(
            shrinkWrap: true,
            itemCount: _accountList.length,
            separatorBuilder: (_, __) => const SizedBox(height: 12),
            itemBuilder: (context, index) {
              final account = _accountList[index];
              return Material(
                color: theme.colorScheme.onSurface.withAlpha(8),
                borderRadius: BorderRadius.circular(16),
                child: InkWell(
                  onTap: _isLoggingIn ? null : () => _loginByMobile(selectedUserId: account['userid']),
                  borderRadius: BorderRadius.circular(16),
                  child: Padding(
                    padding: const EdgeInsets.all(12),
                    child: Row(
                      children: [
                        ClipRRect(
                          borderRadius: BorderRadius.circular(10),
                          child: Image.network(
                            account['pic'] ?? '',
                            width: 44, height: 44,
                            errorBuilder: (_, __, ___) => Container(
                              color: accentColor.withAlpha(20),
                              width: 44, height: 44,
                              child: Icon(Icons.person, color: accentColor),
                            ),
                          ),
                        ),
                        const SizedBox(width: 14),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                account['nickname'] ?? '未命名用户',
                                style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 15),
                                maxLines: 1, overflow: TextOverflow.ellipsis,
                              ),
                              const SizedBox(height: 2),
                              Text(
                                'Lv.${account['p_grade'] ?? 0} · UID: ${account['userid']}',
                                style: TextStyle(color: theme.colorScheme.onSurfaceVariant, fontSize: 11, fontWeight: FontWeight.w600),
                              ),
                            ],
                          ),
                        ),
                        Icon(Icons.chevron_right_rounded, color: theme.colorScheme.onSurfaceVariant, size: 20),
                      ],
                    ),
                  ),
                ),
              );
            },
          ),
        ),
        if (_isLoggingIn)
          Padding(
            padding: const EdgeInsets.only(top: 20),
            child: CircularProgressIndicator(strokeWidth: 3, color: accentColor),
          ),
        const SizedBox(height: 24),
        TextButton(
          onPressed: () => setState(() => _showAccountSelection = false),
          child: Text('返回登录', style: TextStyle(color: theme.colorScheme.onSurfaceVariant, fontWeight: FontWeight.w800)),
        ),
      ],
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
          '使用酷狗概念版APP扫码', 
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
          onChanged: (_) {
            if (_mobileError != null) setState(() => _mobileError = null);
          },
          style: TextStyle(color: textColor, fontWeight: FontWeight.w600),
          decoration: InputDecoration(
            hintText: '手机号码',
            errorText: _mobileError,
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
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: TextField(
                controller: _codeController,
                keyboardType: TextInputType.number,
                onChanged: (_) {
                  if (_codeError != null) setState(() => _codeError = null);
                },
                style: TextStyle(color: textColor, fontWeight: FontWeight.w600),
                decoration: InputDecoration(
                  hintText: '验证码',
                  errorText: _codeError,
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
            onPressed: _isLoggingIn ? null : _loginByMobile,
            style: ElevatedButton.styleFrom(
              backgroundColor: theme.colorScheme.onSurface,
              foregroundColor: theme.colorScheme.surface,
              elevation: 0,
              shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
            ),
            child: _isLoggingIn 
              ? SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: theme.colorScheme.surface))
              : const Text('立即登录', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w800)),
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
