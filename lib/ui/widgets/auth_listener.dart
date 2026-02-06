import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import '../../providers/user_provider.dart';
import '../screens/login_screen.dart';
import '../widgets/custom_dialog.dart';
import '../../main.dart'; // To access navigatorKey

class AuthListener extends StatefulWidget {
  final Widget child;
  const AuthListener({super.key, required this.child});

  @override
  State<AuthListener> createState() => _AuthListenerState();
}

class _AuthListenerState extends State<AuthListener> {
  bool _isShowingDialog = false;

  @override
  void initState() {
    super.initState();
    // Use addPostFrameCallback to ensure context is ready if needed, 
    // but here we are setting a callback on the provider.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      final userProvider = context.read<UserProvider>();
      userProvider.onSessionExpired = _handleSessionExpired;
    });
  }

  void _handleSessionExpired() {
    if (_isShowingDialog) return;
    
    _isShowingDialog = true;
    final context = navigatorKey.currentContext;
    if (context == null) {
      _isShowingDialog = false;
      return;
    }

    CustomDialog.show(
      context,
      title: '登录已过期',
      content: '您的登录信息已失效，为了您的账号安全，请重新登录。',
      confirmText: '去登录',
      showCancel: true,
      cancelText: '稍后再说',
    ).then((confirmed) {
      _isShowingDialog = false;
      if (confirmed == true) {
        Navigator.of(context).push(
          CupertinoPageRoute(builder: (_) => const LoginScreen()),
        );
      }
    });
  }

  @override
  Widget build(BuildContext context) => widget.child;
}
