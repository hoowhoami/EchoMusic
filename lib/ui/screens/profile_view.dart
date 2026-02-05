import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import '../../providers/user_provider.dart';
import 'package:cached_network_image/cached_network_image.dart';
import '../widgets/scrollable_content.dart';
import '../widgets/custom_dialog.dart';

class ProfileView extends StatefulWidget {
  const ProfileView({super.key});

  @override
  State<ProfileView> createState() => _ProfileViewState();
}

class _ProfileViewState extends State<ProfileView> {
  bool _isLoading = false;

  @override
  Widget build(BuildContext context) {
    final userProvider = context.watch<UserProvider>();
    final user = userProvider.user;
    final theme = Theme.of(context);

    if (!userProvider.isAuthenticated) {
      return Center(child: Text('请先登录', style: TextStyle(color: theme.colorScheme.onSurface.withAlpha(60))));
    }

    final detail = user?.extendsInfo?['detail'] ?? {};
    final vipInfo = user?.extendsInfo?['vip'] ?? {};
    final busiVip = vipInfo['busi_vip'] as List? ?? [];
    
    final tvip = busiVip.firstWhere((v) => v['product_type'] == 'tvip' && v['is_vip'] == 1, orElse: () => null);
    final svip = busiVip.firstWhere((v) => v['product_type'] == 'svip' && v['is_vip'] == 1, orElse: () => null);

    final gender = detail['gender'] == 1 ? '男' : (detail['gender'] == 0 ? '女' : '保密');

    return Scaffold(
      backgroundColor: Colors.transparent,
      body: ScrollableContent(
        padding: const EdgeInsets.symmetric(horizontal: 40, vertical: 30),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Text(
                  '个人中心',
                  style: TextStyle(
                    fontSize: 28,
                    fontWeight: FontWeight.w700,
                    color: theme.colorScheme.onSurface,
                    letterSpacing: -0.5,
                  ),
                ),
                const Spacer(),
                if (_isLoading)
                  const CupertinoActivityIndicator()
                else
                  IconButton(
                    icon: const Icon(CupertinoIcons.refresh, size: 20),
                    onPressed: () async {
                      setState(() => _isLoading = true);
                      await userProvider.fetchAllUserData();
                      setState(() => _isLoading = false);
                    },
                    color: theme.colorScheme.onSurfaceVariant,
                  ),
              ],
            ),
            const SizedBox(height: 32),

            // Profile Card
            Container(
              padding: const EdgeInsets.all(24),
              decoration: BoxDecoration(
                color: theme.colorScheme.onSurface.withAlpha(10),
                borderRadius: BorderRadius.circular(20),
                border: Border.all(color: theme.colorScheme.outlineVariant),
              ),
              child: Row(
                children: [
                  CircleAvatar(
                    radius: 44,
                    backgroundColor: theme.colorScheme.primary.withAlpha(20),
                    backgroundImage: user?.pic != null ? CachedNetworkImageProvider(user!.pic!) : null,
                    child: user?.pic == null ? Icon(CupertinoIcons.person_fill, size: 40, color: theme.colorScheme.primary) : null,
                  ),
                  const SizedBox(width: 24),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Text(
                              user?.nickname ?? '',
                              style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w800),
                            ),
                            const SizedBox(width: 12),
                            if (tvip != null)
                              _buildVipTag('TVIP', Colors.green),
                            const SizedBox(width: 4),
                            if (svip != null)
                              _buildVipTag('SVIP', Colors.orange),
                          ],
                        ),
                        const SizedBox(height: 8),
                        Text(
                          'Lv.${detail['p_grade'] ?? 0} • ${detail['follows'] ?? 0} 关注 • ${detail['fans'] ?? 0} 粉丝 • ${detail['nvisitors'] ?? 0} 访客',
                          style: TextStyle(color: theme.colorScheme.onSurfaceVariant, fontSize: 13, fontWeight: FontWeight.w600),
                        ),
                        if (detail['descri'] != null && detail['descri'].toString().isNotEmpty)
                          Padding(
                            padding: const EdgeInsets.only(top: 8),
                            child: Text(
                              '个性签名: ${detail['descri']}',
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(color: theme.colorScheme.onSurface.withAlpha(100), fontSize: 12, fontWeight: FontWeight.w500),
                            ),
                          ),
                      ],
                    ),
                  ),
                  CupertinoButton(
                    onPressed: () => _showLogoutDialog(context, userProvider),
                    child: Text('退出登录', style: TextStyle(color: theme.colorScheme.error, fontWeight: FontWeight.bold)),
                  ),
                ],
              ),
            ),

            const SizedBox(height: 32),
            _buildSectionHeader('账号信息'),
            _buildInfoCard(theme, [
              _buildInfoItem(theme, '用户ID', user?.userid.toString() ?? ''),
              _buildInfoItem(theme, '性别', gender),
              _buildInfoItem(theme, '用户乐龄', _formatLeLing(detail['rtime'])),
              _buildInfoItem(theme, '听歌时长', _formatDuration(detail['duration'])),
              _buildInfoItem(theme, 'IP属地', detail['loc'] ?? '未知'),
              _buildInfoItem(theme, '所在城市', detail['city'] ?? '未知'),
            ]),

            const SizedBox(height: 32),
            _buildSectionHeader('每日权益领取'),
            _buildVipWorkflow(context, userProvider),

            const SizedBox(height: 100),
          ],
        ),
      ),
    );
  }

  Widget _buildVipWorkflow(BuildContext context, UserProvider provider) {
    return Column(
      children: [
        _buildVipStepCard(
          context,
          step: 1,
          title: '领取畅听VIP',
          subtitle: '解锁基础听歌权限，普通音质',
          isCompleted: provider.isTvipClaimedToday,
          buttonText: provider.isTvipClaimedToday ? '已领取' : '立即领取',
          onTap: () async {
            setState(() => _isLoading = true);
            final success = await provider.claimTvip();
            setState(() => _isLoading = false);
            if (context.mounted) {
              ScaffoldMessenger.of(context).showSnackBar(
                SnackBar(content: Text(success ? '领取成功' : '领取失败，请稍后再试')),
              );
            }
          },
          color: Colors.green,
        ),
        const SizedBox(height: 16),
        _buildVipStepCard(
          context,
          step: 2,
          title: '升级至概念VIP',
          subtitle: '解锁顶级音质和音效特权',
          isCompleted: provider.isSvipClaimedToday,
          isEnabled: provider.isTvipClaimedToday,
          buttonText: provider.isSvipClaimedToday ? '已升级' : '立即升级',
          onTap: () async {
            setState(() => _isLoading = true);
            final success = await provider.upgradeSvip();
            setState(() => _isLoading = false);
            if (context.mounted) {
              ScaffoldMessenger.of(context).showSnackBar(
                SnackBar(content: Text(success ? '升级成功' : '升级失败，请确认是否已领取畅听VIP')),
              );
            }
          },
          color: Colors.orange,
        ),
      ],
    );
  }

  Widget _buildVipStepCard(BuildContext context, {
    required int step,
    required String title,
    required String subtitle,
    required bool isCompleted,
    bool isEnabled = true,
    required String buttonText,
    required VoidCallback onTap,
    required Color color,
  }) {
    final theme = Theme.of(context);
    final bool active = isEnabled && !isCompleted;

    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: theme.colorScheme.onSurface.withAlpha(8),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(
          color: isCompleted ? color.withAlpha(100) : theme.colorScheme.outlineVariant,
          width: isCompleted ? 1.5 : 1,
        ),
      ),
      child: Row(
        children: [
          Container(
            width: 48,
            height: 48,
            decoration: BoxDecoration(
              color: (isCompleted ? color : Colors.grey).withAlpha(30),
              shape: BoxShape.circle,
            ),
            child: Center(
              child: Icon(
                isCompleted ? CupertinoIcons.check_mark_circled : CupertinoIcons.circle,
                color: isCompleted ? color : Colors.grey,
                size: 28,
              ),
            ),
          ),
          const SizedBox(width: 20),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '步骤 $step: $title',
                  style: const TextStyle(fontSize: 16, fontWeight: FontWeight.w800),
                ),
                const SizedBox(height: 4),
                Text(
                  subtitle,
                  style: TextStyle(color: theme.colorScheme.onSurfaceVariant, fontSize: 13, fontWeight: FontWeight.w500),
                ),
              ],
            ),
          ),
          const SizedBox(width: 16),
          CupertinoButton(
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 10),
            color: isCompleted ? color.withAlpha(30) : (active ? color : Colors.grey.withAlpha(100)),
            borderRadius: BorderRadius.circular(20),
            onPressed: active ? onTap : null,
            child: Text(
              buttonText,
              style: TextStyle(
                color: isCompleted ? color : (active ? Colors.white : Colors.grey),
                fontSize: 13,
                fontWeight: FontWeight.bold,
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildVipTag(String text, Color color) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: color.withAlpha(30),
        borderRadius: BorderRadius.circular(4),
        border: Border.all(color: color.withAlpha(100), width: 0.5),
      ),
      child: Text(text, style: TextStyle(color: color, fontSize: 10, fontWeight: FontWeight.bold)),
    );
  }

  Widget _buildSectionHeader(String title) {
    return Padding(
      padding: const EdgeInsets.only(left: 4, bottom: 12),
      child: Text(
        title,
        style: const TextStyle(fontSize: 16, fontWeight: FontWeight.bold),
      ),
    );
  }

  Widget _buildInfoCard(ThemeData theme, List<Widget> children) {
    return Container(
      decoration: BoxDecoration(
        color: theme.colorScheme.onSurface.withAlpha(8),
        borderRadius: BorderRadius.circular(16),
      ),
      child: Column(
        children: [
          for (int i = 0; i < children.length; i++) ...[
            children[i],
            if (i < children.length - 1)
              Divider(height: 1, indent: 16, endIndent: 16, color: theme.colorScheme.outlineVariant),
          ],
        ],
      ),
    );
  }

  Widget _buildInfoItem(ThemeData theme, String label, String value) {
    return Padding(
      padding: const EdgeInsets.all(16.0),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: TextStyle(color: theme.colorScheme.onSurfaceVariant, fontSize: 14)),
          Text(value, style: const TextStyle(fontWeight: FontWeight.w500, fontSize: 14)),
        ],
      ),
    );
  }

  String _formatLeLing(dynamic rtime) {
    if (rtime == null) return '未知';
    final DateTime start = DateTime.fromMillisecondsSinceEpoch(int.tryParse(rtime.toString())! * 1000);
    final Duration diff = DateTime.now().difference(start);
    if (diff.inDays > 365) return '${(diff.inDays / 365).floor()}年';
    if (diff.inDays > 30) return '${(diff.inDays / 30).floor()}个月';
    return '${diff.inDays}天';
  }

  String _formatDuration(dynamic minutes) {
    if (minutes == null) return '0小时';
    final int m = int.tryParse(minutes.toString()) ?? 0;
    if (m > 60) return '${(m / 60).floor()}小时${m % 60}分钟';
    return '$m分钟';
  }

  void _showLogoutDialog(BuildContext context, UserProvider userProvider) {
    CustomDialog.show(
      context,
      title: '退出登录',
      content: '确定要退出当前账号吗？',
      confirmText: '退出登录',
      isDestructive: true,
    ).then((confirmed) {
      if (confirmed == true) {
        userProvider.logout();
      }
    });
  }
}