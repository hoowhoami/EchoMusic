import 'package:flutter/material.dart';
import 'custom_dialog.dart';

class DisclaimerDialog extends StatelessWidget {
  const DisclaimerDialog({super.key});

  @override
  Widget build(BuildContext context) {
    return CustomDialog(
      title: '免责声明',
      width: 600,
      confirmText: '我知道了',
      onConfirm: () => Navigator.of(context).pop(),
      contentWidget: ConstrainedBox(
        constraints: const BoxConstraints(maxHeight: 400),
        child: SingleChildScrollView(
          physics: const BouncingScrollPhysics(),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _buildSection('1.', '本程序是酷狗第三方客户端，并非酷狗官方，需要更完善的功能请下载官方客户端体验。'),
              _buildSection('2.', '本项目仅供学习使用，请尊重版权，请勿利用此项目从事商业行为及非法用途！'),
              _buildSection('3.', '使用本项目的过程中可能会产生版权数据。对于这些版权数据，本项目不拥有它们的所有权。为了避免侵权，使用者务必在 24 小时内清除使用本项目的过程中所产生的版权数据。'),
              _buildSection('4.', '由于使用本项目产生的包括由于本协议或由于使用或无法使用本项目而引起的任何性质的任何直接、间接、特殊、偶然或结果性损害由使用者负责。'),
              _buildSection('5.', '禁止在违反当地法律法规的情况下使用本项目。对于使用者在明知或不知当地法律法规不允许的情况下使用本项目所造成的任何违法违规行为由使用者承担。'),
              _buildSection('6.', '音乐平台不易，请尊重版权，支持正版。'),
              _buildSection('7.', '本项目仅用于对技术可行性的探索及研究，不接受任何商业（包括但不限于广告等）合作及捐赠。'),
              _buildSection('8.', '如果官方音乐平台觉得本项目不妥，可联系本项目更改或移除。'),
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