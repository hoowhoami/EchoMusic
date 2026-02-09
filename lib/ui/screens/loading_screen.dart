import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:flutter_spinkit/flutter_spinkit.dart';
import '../../utils/server_orchestrator.dart';
import 'home_screen.dart';

class LoadingScreen extends StatefulWidget {
  const LoadingScreen({super.key});

  @override
  State<LoadingScreen> createState() => _LoadingScreenState();
}

class _LoadingScreenState extends State<LoadingScreen> {
  String _statusMessage = '正在初始化音乐引擎...';
  bool _hasError = false;

  @override
  void initState() {
    super.initState();
    _startServer();
  }

  Future<void> _startServer() async {
    try {
      final success = await ServerOrchestrator.start();
      if (success) {
        if (mounted) {
          // 增加一点点延迟，让动画展示完整
          await Future.delayed(const Duration(milliseconds: 800));
          if (mounted) {
            Navigator.of(context).pushReplacement(
              PageRouteBuilder(
                pageBuilder: (context, animation, secondaryAnimation) => const HomeScreen(),
                transitionsBuilder: (context, animation, secondaryAnimation, child) {
                  return FadeTransition(opacity: animation, child: child);
                },
                transitionDuration: const Duration(milliseconds: 600),
              ),
            );
          }
        }
      } else {
        if (mounted) {
          setState(() {
            _statusMessage = '服务启动失败';
            _hasError = true;
          });
        }
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _statusMessage = '启动异常: $e';
          _hasError = true;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isDark = theme.brightness == Brightness.dark;
    
    return Scaffold(
      backgroundColor: theme.scaffoldBackgroundColor, // 基础背景色
      body: Stack(
        children: [
          // 背景渐变：使用主题中的背景色和表面色，确保自适应
          Container(
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: Alignment.topCenter,
                end: Alignment.bottomCenter,
                colors: [
                  theme.colorScheme.surface,
                  theme.scaffoldBackgroundColor,
                ],
              ),
            ),
          ),
          
          // 装饰性的圆：颜色随主色调和亮度变化
          Positioned(
            top: -100,
            right: -100,
            child: Container(
              width: 300,
              height: 300,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: theme.colorScheme.primary.withAlpha(isDark ? 20 : 15),
              ),
            ),
          ),
          
          Center(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                // Logo 区域：容器背景和边框随亮度变化
                Container(
                  width: 120,
                  height: 120,
                  decoration: BoxDecoration(
                    color: theme.colorScheme.onSurface.withAlpha(isDark ? 10 : 5),
                    borderRadius: BorderRadius.circular(32),
                    border: Border.all(
                      color: theme.colorScheme.onSurface.withAlpha(isDark ? 15 : 10),
                      width: 1,
                    ),
                  ),
                  child: Center(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          'Echo',
                          style: TextStyle(
                            fontSize: 24,
                            fontWeight: FontWeight.w800,
                            color: theme.colorScheme.onSurface,
                            letterSpacing: -1,
                          ),
                        ),
                        Text(
                          'MUSIC',
                          style: TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.w900,
                            color: theme.colorScheme.primary,
                            letterSpacing: 2,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
                
                const SizedBox(height: 60),
                
                // 状态显示
                if (!_hasError) ...[
                  SizedBox(
                    width: 200,
                    child: Column(
                      children: [
                        SpinKitThreeBounce(
                          color: theme.colorScheme.primary.withAlpha(150),
                          size: 24.0,
                        ),
                        const SizedBox(height: 24),
                        Text(
                          _statusMessage,
                          style: TextStyle(
                            color: theme.colorScheme.onSurface.withAlpha(100),
                            fontSize: 13,
                            fontWeight: FontWeight.w600,
                            letterSpacing: 0.5,
                          ),
                          textAlign: TextAlign.center,
                        ),
                      ],
                    ),
                  ),
                ] else ...[
                  // 错误显示
                  Icon(CupertinoIcons.exclamationmark_triangle_fill, 
                    color: theme.colorScheme.error.withAlpha(200), size: 48),
                  const SizedBox(height: 24),
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 40),
                    child: Text(
                      _statusMessage,
                      style: TextStyle(color: theme.colorScheme.error.withAlpha(180), fontSize: 14),
                      textAlign: TextAlign.center,
                    ),
                  ),
                  const SizedBox(height: 48),
                  Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      _buildButton(
                        onPressed: () async {
                          setState(() {
                            _hasError = false;
                            _statusMessage = '正在重新尝试启动...';
                          });
                          await ServerOrchestrator.killPort();
                          _startServer();
                        },
                        label: '重试',
                        isPrimary: true,
                        context: context,
                      ),
                      const SizedBox(width: 16),
                      _buildButton(
                        onPressed: () async {
                          await ServerOrchestrator.killPort();
                          exit(0);
                        },
                        label: '退出',
                        isPrimary: false,
                        context: context,
                      ),
                    ],
                  ),
                ],
              ],
            ),
          ),
          
          // 底部版权或版本信息
          Positioned(
            bottom: 40,
            left: 0,
            right: 0,
            child: Text(
              'EchoMusic • 音为你而生',
              style: TextStyle(
                color: theme.colorScheme.onSurface.withAlpha(60),
                fontSize: 12,
                fontWeight: FontWeight.w600,
                letterSpacing: 1.2,
              ),
              textAlign: TextAlign.center,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildButton({
    required VoidCallback onPressed,
    required String label,
    required bool isPrimary,
    required BuildContext context,
  }) {
    final theme = Theme.of(context);
    return InkWell(
      onTap: onPressed,
      borderRadius: BorderRadius.circular(12),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 12),
        decoration: BoxDecoration(
          color: isPrimary ? theme.colorScheme.primary : theme.colorScheme.onSurface.withAlpha(10),
          borderRadius: BorderRadius.circular(12),
        ),
        child: Text(
          label,
          style: TextStyle(
            color: isPrimary ? theme.colorScheme.onPrimary : theme.colorScheme.onSurface.withAlpha(200),
            fontWeight: FontWeight.w700,
            fontSize: 14,
          ),
        ),
      ),
    );
  }
}
