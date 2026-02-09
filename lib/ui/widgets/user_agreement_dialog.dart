import 'dart:io';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../providers/persistence_provider.dart';
import 'custom_dialog.dart';

class UserAgreementDialog extends StatelessWidget {
  const UserAgreementDialog({super.key});

  @override
  Widget build(BuildContext context) {
    final persistenceProvider = context.read<PersistenceProvider>();

    return CustomDialog(
      title: '用户条款',
      width: 600,
      confirmText: '同意并继续',
      cancelText: '不同意并退出',
      isDestructive: true,
      onCancel: () => exit(0),
      onConfirm: () {
        persistenceProvider.updateSetting('userAgreementAccepted', true);
        Navigator.of(context).pop();
      },
      contentWidget: ConstrainedBox(
        constraints: const BoxConstraints(maxHeight: 400),
        child: SingleChildScrollView(
          physics: const BouncingScrollPhysics(),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _buildSection('1.', '本程序是酷狗第三方客户端，并非酷狗官方，需要更完善的功能请下载官方客户端体验。'),
              _buildSection('2.', '本项目仅供学习交流使用，您在使用过程中应尊重版权，不得用于商业或非法用途。'),
              _buildSection('3.', '在使用本项目的过程中，可能会生成版权内容。本项目不拥有这些版权内容的所有权。为了避免侵权行为，您需在 24 小时内清除由本项目产生的版权内容。'),
              _buildSection('4.', '本项目的开发者不对因使用或无法使用本项目所导致的任何损害承担责任，包括但不限于数据丢失、停工、计算机故障或其他经济损失。'),
              _buildSection('5.', '您不得在违反当地法律法规的情况下使用本项目。因违反法律法规所导致的任何法律后果由用户承担。'),
              _buildSection('6.', '本项目仅用于技术探索和研究，不接受任何商业合作、广告或捐赠。如果官方音乐平台对此项目存有疑虑，可随时联系开发者移除相关内容。'),
              const SizedBox(height: 16),
              const Text(
                '同意继续使用本项目，您即接受以上条款声明内容。',
                style: TextStyle(
                  fontWeight: FontWeight.w800,
                  fontSize: 14,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildSection(String index, String content) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            index,
            style: const TextStyle(fontWeight: FontWeight.w800, fontSize: 14),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              content,
              style: const TextStyle(height: 1.6, fontSize: 14, fontWeight: FontWeight.w500),
            ),
          ),
        ],
      ),
    );
  }
}