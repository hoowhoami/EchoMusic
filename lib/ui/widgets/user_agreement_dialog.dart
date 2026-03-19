import 'dart:io';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../providers/persistence_provider.dart';
import 'custom_dialog.dart';
import 'package:echomusic/theme/app_theme.dart';

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
              _buildSection('1. 项目性质', '本程序是酷狗音乐第三方客户端，非官方产品。如需完整功能体验，请使用官方客户端。'),
              _buildSection('2. 使用范围', '本项目仅供个人学习和技术研究使用。您不得将本项目用于任何商业用途或违反法律法规的行为。'),
              _buildSection('3. 版权内容', '本项目通过公开接口获取音乐数据，不存储任何音频文件。所有音乐内容版权归原平台及版权方所有。使用过程中产生的缓存数据应在 24 小时内清除。'),
              _buildSection('4. 免责条款', '开发者不对因使用本项目导致的任何直接或间接损失承担责任，包括但不限于数据丢失、设备故障、法律纠纷等。'),
              _buildSection('5. 法律责任', '您应遵守所在地区的法律法规使用本项目。因违法使用导致的一切法律后果由使用者自行承担。'),
              _buildSection('6. 版权尊重', '请尊重音乐创作者和平台的劳动成果，支持正版音乐。本项目不接受任何商业合作、广告或捐赠。'),
              _buildSection('7. 争议处理', '如版权方对本项目有异议，请通过 GitHub Issues 联系开发者，我们将及时处理。'),
              const SizedBox(height: 16),
              const Text(
                '点击"同意并继续"即表示您已阅读并接受以上全部条款。',
                style: TextStyle(
                  fontWeight: AppTheme.fontWeightSemiBold,
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
            style: const TextStyle(fontWeight: AppTheme.fontWeightSemiBold, fontSize: 14),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              content,
              style: const TextStyle(height: 1.6, fontSize: 14, fontWeight: AppTheme.fontWeightMedium),
            ),
          ),
        ],
      ),
    );
  }
}