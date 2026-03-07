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
              _buildSection('项目定位', '本项目是基于公开接口开发的第三方音乐客户端，仅用于技术学习和研究，不涉及任何商业行为。'),
              _buildSection('数据来源', '所有音乐数据均通过公开 API 接口获取，本项目不存储、不传播任何音频文件。音乐内容版权归原平台及版权方所有。'),
              _buildSection('使用限制', '本项目仅供个人学习使用，禁止用于商业用途或违法行为。使用者应遵守当地法律法规，尊重知识产权。'),
              _buildSection('责任声明', '因使用本项目产生的任何直接或间接损失，包括但不限于法律纠纷、数据丢失、设备故障等，均由使用者自行承担。'),
              _buildSection('版权尊重', '音乐创作不易，请支持正版。建议仅将本项目用于试听，如需长期使用请购买官方会员服务。'),
              _buildSection('开源协议', '本项目基于 MIT 协议开源，不接受任何形式的商业合作、广告植入或捐赠。'),
              _buildSection('争议解决', '如版权方认为本项目侵犯其权益，请通过 GitHub Issues 联系，我们将积极配合处理。'),
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