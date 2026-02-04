import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import '../../providers/user_provider.dart';
import 'package:cached_network_image/cached_network_image.dart';

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
    final isDark = Theme.of(context).brightness == Brightness.dark;

    if (!userProvider.isAuthenticated) {
      return const Center(child: Text('请先登录', style: TextStyle(color: Colors.white30)));
    }

    final detail = user?.extendsInfo?['detail'] ?? {};
    final vipInfo = user?.extendsInfo?['vip'] ?? {};
    final busiVip = vipInfo['busi_vip'] as List? ?? [];
    
    final tvip = busiVip.firstWhere((v) => v['product_type'] == 'tvip' && v['is_vip'] == 1, orElse: () => null);
    final svip = busiVip.firstWhere((v) => v['product_type'] == 'svip' && v['is_vip'] == 1, orElse: () => null);

    return Scaffold(
      backgroundColor: Colors.transparent,
      body: SingleChildScrollView(
        padding: const EdgeInsets.symmetric(horizontal: 40, vertical: 30),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Text(
                  '个人资料',
                  style: TextStyle(
                    fontSize: 28,
                    fontWeight: FontWeight.w700,
                    color: isDark ? Colors.white : Colors.black,
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
                      await userProvider.fetchUserDetails();
                      setState(() => _isLoading = false);
                    },
                    color: isDark ? Colors.white38 : Colors.black38,
                  ),
              ],
            ),
            const SizedBox(height: 32),
            
            // Profile Card
            Container(
              padding: const EdgeInsets.all(24),
              decoration: BoxDecoration(
                color: isDark ? Colors.white.withAlpha(10) : Colors.black.withAlpha(5),
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: isDark ? Colors.white10 : Colors.black12),
              ),
              child: Row(
                children: [
                  CircleAvatar(
                    radius: 40,
                    backgroundImage: user?.pic != null ? CachedNetworkImageProvider(user!.pic!) : null,
                    child: user?.pic == null ? const Icon(CupertinoIcons.person_fill, size: 40) : null,
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
                              style: const TextStyle(fontSize: 20, fontWeight: FontWeight.bold),
                            ),
                            const SizedBox(width: 8),
                            if (tvip != null)
                              _buildVipTag('TVIP', Colors.green),
                            if (svip != null)
                              _buildVipTag('SVIP', Colors.orange),
                          ],
                        ),
                        const SizedBox(height: 8),
                        Text(
                          'Lv.${detail['p_grade'] ?? 0} • ${detail['follows'] ?? 0} 关注 • ${detail['fans'] ?? 0} 粉丝',
                          style: TextStyle(color: isDark ? Colors.white54 : Colors.black54, fontSize: 13),
                        ),
                        if (detail['descri'] != null)
                          Padding(
                            padding: const EdgeInsets.only(top: 4),
                            child: Text(
                              detail['descri'],
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(color: isDark ? Colors.white30 : Colors.black38, fontSize: 12),
                            ),
                          ),
                      ],
                    ),
                  ),
                  CupertinoButton(
                    onPressed: () => _showLogoutDialog(context, userProvider),
                    child: const Text('退出登录', style: TextStyle(color: CupertinoColors.destructiveRed)),
                  ),
                ],
              ),
            ),
            
            const SizedBox(height: 32),
            _buildSectionHeader('账号信息'),
            _buildInfoCard(isDark, [
              _buildInfoItem('用户ID', user?.userid.toString() ?? '', isDark),
              _buildInfoItem('用户乐龄', _formatLeLing(detail['rtime']), isDark),
              _buildInfoItem('听歌时长', _formatDuration(detail['duration']), isDark),
              _buildInfoItem('IP属地', detail['loc'] ?? '未知', isDark),
              _buildInfoItem('城市', detail['city'] ?? '未知', isDark),
            ]),
            
            const SizedBox(height: 32),
            _buildSectionHeader('会员特权'),
            _buildInfoCard(isDark, [
              _buildVipInfoItem('畅听VIP', tvip, Colors.green, isDark, () {
                // TODO: Claim TVIP
              }),
              _buildVipInfoItem('概念VIP', svip, Colors.orange, isDark, () {
                // TODO: Claim SVIP
              }),
            ]),
            
            const SizedBox(height: 100),
          ],
        ),
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

  Widget _buildInfoCard(bool isDark, List<Widget> children) {
    return Container(
      decoration: BoxDecoration(
        color: isDark ? Colors.white.withAlpha(10) : Colors.black.withAlpha(5),
        borderRadius: BorderRadius.circular(16),
      ),
      child: Column(
        children: [
          for (int i = 0; i < children.length; i++) ...[
            children[i],
            if (i < children.length - 1)
              Divider(height: 1, indent: 16, endIndent: 16, color: isDark ? Colors.white10 : Colors.black12),
          ],
        ],
      ),
    );
  }

  Widget _buildInfoItem(String label, String value, bool isDark) {
    return Padding(
      padding: const EdgeInsets.all(16.0),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: TextStyle(color: isDark ? Colors.white54 : Colors.black54, fontSize: 14)),
          Text(value, style: const TextStyle(fontWeight: FontWeight.w500, fontSize: 14)),
        ],
      ),
    );
  }

  Widget _buildVipInfoItem(String label, dynamic vip, Color color, bool isDark, VoidCallback onTap) {
    final bool isActive = vip != null;
    return Padding(
      padding: const EdgeInsets.all(16.0),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(label, style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 15)),
                if (isActive)
                  Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Text('${vip['vip_begin_time']} ~ ${vip['vip_end_time']}', style: TextStyle(color: isDark ? Colors.white38 : Colors.black38, fontSize: 12)),
                  )
                else
                  const Padding(
                    padding: EdgeInsets.only(top: 4),
                    child: Text('未激活', style: TextStyle(color: Colors.grey, fontSize: 12)),
                  ),
              ],
            ),
          ),
          CupertinoButton(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
            color: isActive ? color.withAlpha(40) : color,
            borderRadius: BorderRadius.circular(20),
            onPressed: isActive ? null : onTap,
            child: Text(isActive ? '已激活' : '立即领取', style: TextStyle(color: isActive ? color : Colors.white, fontSize: 12, fontWeight: FontWeight.bold)),
          ),
        ],
      ),
    );
  }

  String _formatLeLing(dynamic rtime) {
    if (rtime == null) return '未知';
    final DateTime start = DateTime.fromMillisecondsSinceEpoch(rtime * 1000);
    final Duration diff = DateTime.now().difference(start);
    if (diff.inDays > 365) return '${(diff.inDays / 365).floor()}年';
    if (diff.inDays > 30) return '${(diff.inDays / 30).floor()}个月';
    return '${diff.inDays}天';
  }

  String _formatDuration(dynamic minutes) {
    if (minutes == null) return '0小时';
    final int m = minutes as int;
    if (m > 60) return '${(m / 60).floor()}小时${m % 60}分钟';
    return '$m分钟';
  }

  void _showLogoutDialog(BuildContext context, UserProvider userProvider) {
    showCupertinoDialog(
      context: context,
      builder: (context) => CupertinoAlertDialog(
        title: const Text('退出登录'),
        content: const Text('确定要退出当前账号吗？'),
        actions: [
          CupertinoDialogAction(
            child: const Text('取消'),
            onPressed: () => Navigator.pop(context),
          ),
          CupertinoDialogAction(
            isDestructiveAction: true,
            onPressed: () {
              userProvider.logout();
              Navigator.pop(context);
            },
            child: const Text('退出'),
          ),
        ],
      ),
    );
  }
}

