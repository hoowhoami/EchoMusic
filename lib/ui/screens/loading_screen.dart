import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_spinkit/flutter_spinkit.dart';
import '../../utils/server_orchestrator.dart';
import 'home_screen.dart';

class LoadingScreen extends StatefulWidget {
  const LoadingScreen({super.key});

  @override
  State<LoadingScreen> createState() => _LoadingScreenState();
}

class _LoadingScreenState extends State<LoadingScreen> {
  String _statusMessage = '正在启动服务...';
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
          Navigator.of(context).pushReplacement(
            MaterialPageRoute(builder: (_) => const HomeScreen()),
          );
        }
      } else {
        if (mounted) {
          setState(() {
            _statusMessage = '服务启动失败，请检查文件是否完整或重启应用。';
            _hasError = true;
          });
        }
      }
    } catch (e) {
      debugPrint('[Loading] Error during startup: $e');
      if (mounted) {
        setState(() {
          _statusMessage = '由于权限或系统错误，服务启动中断：$e';
          _hasError = true;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      body: Container(
        decoration: BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [
              theme.scaffoldBackgroundColor,
              theme.colorScheme.surface,
            ],
          ),
        ),
        child: Center(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              if (!_hasError)
                SpinKitDoubleBounce(
                  color: theme.colorScheme.primary,
                  size: 80.0,
                )
              else
                Icon(Icons.error_outline_rounded, color: theme.colorScheme.error, size: 80),
              const SizedBox(height: 40),
              Text(
                _statusMessage,
                style: TextStyle(color: theme.colorScheme.onSurface.withAlpha(180), fontSize: 18),
                textAlign: TextAlign.center,
              ),
              if (_hasError) ...[
                const SizedBox(height: 40),
                Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    ElevatedButton(
                      onPressed: () async {
                        setState(() {
                          _hasError = false;
                          _statusMessage = '正在重新尝试启动服务...';
                        });
                        await ServerOrchestrator.killPort();
                        _startServer();
                      },
                      style: ElevatedButton.styleFrom(
                        backgroundColor: theme.colorScheme.primary,
                        foregroundColor: theme.colorScheme.onPrimary,
                      ),
                      child: const Text('重试'),
                    ),
                    const SizedBox(width: 20),
                    OutlinedButton(
                      onPressed: () async {
                        await ServerOrchestrator.killPort();
                        exit(0);
                      },
                      style: OutlinedButton.styleFrom(
                        foregroundColor: theme.colorScheme.onSurface.withAlpha(180),
                        side: BorderSide(color: theme.colorScheme.outlineVariant),
                      ),
                      child: const Text('退出应用'),
                    ),
                  ],
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}