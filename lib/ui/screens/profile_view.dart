import 'package:flutter/material.dart';
import 'package:flutter/cupertino.dart';
import 'package:provider/provider.dart';
import '../../providers/user_provider.dart';
import '../../providers/refresh_provider.dart';
import 'package:cached_network_image/cached_network_image.dart';
import '../widgets/scrollable_content.dart';
import '../widgets/custom_dialog.dart';
import '../widgets/custom_toast.dart';

class ProfileView extends StatefulWidget {
  const ProfileView({super.key});

  @override
  State<ProfileView> createState() => _ProfileViewState();
}

class _ProfileViewState extends State<ProfileView> with RefreshableState {
  bool _isLoading = false;

  @override
  void onRefresh() {
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final userProvider = context.watch<UserProvider>();
    final user = userProvider.user;
    final theme = Theme.of(context);

    if (!userProvider.isAuthenticated) {
      return Scaffold(
        backgroundColor: theme.scaffoldBackgroundColor,
        body: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(CupertinoIcons.person_crop_circle_badge_exclam, size: 64, color: theme.colorScheme.onSurface.withAlpha(30)),
              const SizedBox(height: 16),
              Text('请先登录以查看个人中心', style: TextStyle(color: theme.colorScheme.onSurface.withAlpha(100), fontSize: 16, fontWeight: FontWeight.w600)),
            ],
          ),
        ),
      );
    }

    final detail = user?.extendsInfo?['detail'] ?? {};
    final vipInfo = user?.extendsInfo?['vip'] ?? {};
    final busiVip = vipInfo['busi_vip'] as List? ?? [];
    
    final tvip = busiVip.firstWhere((v) => v['product_type'] == 'tvip' && v['is_vip'] == 1, orElse: () => null);
    final svip = busiVip.firstWhere((v) => v['product_type'] == 'svip' && v['is_vip'] == 1, orElse: () => null);

    final gender = detail['gender'] == 1 ? '男' : (detail['gender'] == 0 ? '女' : '保密');

    return Scaffold(
      backgroundColor: theme.scaffoldBackgroundColor,
      body: ScrollableContent(
        padding: const EdgeInsets.symmetric(horizontal: 40, vertical: 40),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            _buildHeader(context, userProvider),
            const SizedBox(height: 40),
            
            // User Profile Card
            _buildUserCard(context, user, detail, tvip, svip),
            const SizedBox(height: 40),

            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  flex: 3,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      _buildSectionHeader(context, '账号档案', CupertinoIcons.doc_person),
                      const SizedBox(height: 16),
                      _buildProfileDetails(context, user, detail, gender),
                    ],
                  ),
                ),
                const SizedBox(width: 40),
                Expanded(
                  flex: 2,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      _buildSectionHeader(context, '每日权益', CupertinoIcons.gift),
                      const SizedBox(height: 16),
                      _buildVipWorkflow(context, userProvider),
                    ],
                  ),
                ),
              ],
            ),
            
            const SizedBox(height: 20),
          ],
        ),
      ),
    );
  }

  Widget _buildHeader(BuildContext context, UserProvider userProvider) {
    final theme = Theme.of(context);
    return Row(
      children: [
        Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '个人中心',
              style: TextStyle(
                fontSize: 32,
                fontWeight: FontWeight.w900,
                color: theme.colorScheme.onSurface,
                letterSpacing: -1.0,
              ),
            ),
            const SizedBox(height: 4),
            Container(
              width: 40,
              height: 4,
              decoration: BoxDecoration(
                color: theme.colorScheme.primary,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
          ],
        ),
        const Spacer(),
        if (_isLoading)
          const CupertinoActivityIndicator()
        else
          _buildCircleButton(
            context,
            icon: CupertinoIcons.refresh,
            onTap: () async {
              setState(() => _isLoading = true);
              await userProvider.fetchAllUserData();
              setState(() => _isLoading = false);
            },
          ),
        const SizedBox(width: 12),
        _buildCircleButton(
          context,
          icon: CupertinoIcons.square_arrow_right,
          color: theme.colorScheme.error,
          onTap: () => _showLogoutDialog(context, userProvider),
        ),
      ],
    );
  }

  Widget _buildCircleButton(BuildContext context, {required IconData icon, required VoidCallback onTap, Color? color}) {
    final theme = Theme.of(context);
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(20),
        child: Container(
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(
            border: Border.all(color: theme.colorScheme.outlineVariant),
            shape: BoxShape.circle,
          ),
          child: Icon(icon, size: 20, color: color ?? theme.colorScheme.onSurfaceVariant),
        ),
      ),
    );
  }

  Widget _buildUserCard(BuildContext context, dynamic user, dynamic detail, dynamic tvip, dynamic svip) {
    final theme = Theme.of(context);
    return Container(
      padding: const EdgeInsets.all(32),
      decoration: BoxDecoration(
        gradient: LinearGradient(
          colors: [
            theme.colorScheme.primary.withAlpha(20),
            theme.colorScheme.primary.withAlpha(5),
          ],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
        borderRadius: BorderRadius.circular(32),
        border: Border.all(color: theme.colorScheme.primary.withAlpha(30)),
      ),
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.all(4),
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              border: Border.all(color: theme.colorScheme.primary.withAlpha(50), width: 2),
            ),
            child: CircleAvatar(
              radius: 54,
              backgroundColor: theme.colorScheme.primary.withAlpha(20),
              backgroundImage: user?.pic != null ? CachedNetworkImageProvider(user!.pic!) : null,
              child: user?.pic == null ? Icon(CupertinoIcons.person_fill, size: 50, color: theme.colorScheme.primary) : null,
            ),
          ),
          const SizedBox(width: 32),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Text(
                      user?.nickname ?? '',
                      style: const TextStyle(fontSize: 28, fontWeight: FontWeight.w900, letterSpacing: -0.5),
                    ),
                    const SizedBox(width: 16),
                    if (tvip != null) _buildModernVipTag('畅听', Colors.green),
                    if (svip != null) ...[
                      const SizedBox(width: 8),
                      _buildModernVipTag('概念', Colors.orange),
                    ],
                  ],
                ),
                const SizedBox(height: 12),
                if (detail['descri'] != null && detail['descri'].toString().isNotEmpty)
                  Text(
                    detail['descri'],
                    maxLines: 2,
                    style: TextStyle(color: theme.colorScheme.onSurfaceVariant, fontSize: 14, fontWeight: FontWeight.w500),
                  ),
                const SizedBox(height: 20),
                Row(
                  children: [
                    _buildStatItem(context, 'Lv.${detail['p_grade'] ?? 0}', '等级'),
                    _buildStatDivider(context),
                    _buildStatItem(context, '${detail['follows'] ?? 0}', '关注'),
                    _buildStatDivider(context),
                    _buildStatItem(context, '${detail['fans'] ?? 0}', '粉丝'),
                    _buildStatDivider(context),
                    _buildStatItem(context, '${detail['nvisitors'] ?? 0}', '访客'),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildStatItem(BuildContext context, String value, String label) {
    final theme = Theme.of(context);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(value, style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800)),
        Text(label, style: TextStyle(color: theme.colorScheme.onSurfaceVariant, fontSize: 11, fontWeight: FontWeight.w600)),
      ],
    );
  }

  Widget _buildStatDivider(BuildContext context) {
    return Container(
      height: 24,
      width: 1,
      margin: const EdgeInsets.symmetric(horizontal: 24),
      color: Theme.of(context).colorScheme.outlineVariant,
    );
  }

  Widget _buildProfileDetails(BuildContext context, dynamic user, dynamic detail, String gender) {
    return Container(
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.onSurface.withAlpha(10),
        borderRadius: BorderRadius.circular(24),
      ),
      child: Column(
        children: [
          _buildDetailTile(context, CupertinoIcons.number, '用户 ID', user?.userid.toString() ?? ''),
          _buildDetailTile(context, CupertinoIcons.person_circle, '性别', gender),
          _buildDetailTile(context, CupertinoIcons.time, '乐龄', _formatLeLing(detail['rtime'])),
          _buildDetailTile(context, CupertinoIcons.headphones, '累计听歌', _formatDuration(detail['duration'])),
          _buildDetailTile(context, CupertinoIcons.location, '所在地区', '${detail['loc'] ?? '未知'} ${detail['city'] ?? ''}'),
        ],
      ),
    );
  }

  Widget _buildDetailTile(BuildContext context, IconData icon, String label, String value) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
      child: Row(
        children: [
          Icon(icon, size: 18, color: theme.colorScheme.primary.withAlpha(180)),
          const SizedBox(width: 16),
          Text(label, style: TextStyle(color: theme.colorScheme.onSurfaceVariant, fontSize: 14, fontWeight: FontWeight.w600)),
          const Spacer(),
          Text(value, style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w700)),
        ],
      ),
    );
  }

  Widget _buildVipWorkflow(BuildContext context, UserProvider provider) {
    return Column(
      children: [
        _buildVipStepItem(
          context,
          icon: CupertinoIcons.music_house,
          title: '领取畅听会员',
          isCompleted: provider.isTvipClaimedToday,
          onTap: () async {
            setState(() => _isLoading = true);
            final success = await provider.claimTvip();
            setState(() => _isLoading = false);
            if (context.mounted) {
              if (success) {
                CustomToast.success(context, '领取成功');
              } else {
                CustomToast.error(context, '领取失败');
              }
            }
          },
          color: Colors.green,
        ),
        const SizedBox(height: 12),
        _buildVipStepItem(
          context,
          icon: CupertinoIcons.rocket,
          title: '升级概念会员',
          isCompleted: provider.isSvipClaimedToday,
          isEnabled: provider.isTvipClaimedToday,
          onTap: () async {
            setState(() => _isLoading = true);
            final success = await provider.upgradeSvip();
            setState(() => _isLoading = false);
            if (context.mounted) {
              if (success) {
                CustomToast.success(context, '升级成功');
              } else {
                if (!provider.isTvipClaimedToday) {
                  CustomToast.error(context, '请先领取畅听会员');
                } else {
                  CustomToast.error(context, '升级失败或今日已升级');
                }
              }
            }
          },
          color: Colors.orange,
        ),
      ],
    );
  }

  Widget _buildVipStepItem(BuildContext context, {
    required IconData icon,
    required String title,
    required bool isCompleted,
    bool isEnabled = true,
    required VoidCallback onTap,
    required Color color,
  }) {
    final theme = Theme.of(context);
    final active = isEnabled && !isCompleted;

    return InkWell(
      onTap: active ? onTap : null,
      borderRadius: BorderRadius.circular(20),
      child: Container(
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: isCompleted ? color.withAlpha(20) : theme.colorScheme.onSurface.withAlpha(10),
          borderRadius: BorderRadius.circular(20),
          border: Border.all(
            color: isCompleted ? color.withAlpha(50) : Colors.transparent,
          ),
        ),
        child: Row(
          children: [
            Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: (isCompleted ? color : Colors.grey).withAlpha(30),
                shape: BoxShape.circle,
              ),
              child: Icon(icon, color: isCompleted ? color : Colors.grey, size: 20),
            ),
            const SizedBox(width: 16),
            Text(
              title,
              style: TextStyle(
                fontSize: 15,
                fontWeight: FontWeight.w700,
                color: isCompleted ? color : (active ? theme.colorScheme.onSurface : Colors.grey),
              ),
            ),
            const Spacer(),
            if (isCompleted)
              Icon(CupertinoIcons.checkmark_alt_circle_fill, color: color, size: 20)
            else
              Icon(CupertinoIcons.chevron_right, size: 14, color: active ? theme.colorScheme.onSurfaceVariant : Colors.grey.withAlpha(100)),
          ],
        ),
      ),
    );
  }

  Widget _buildModernVipTag(String text, Color color) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        gradient: LinearGradient(colors: [color, color.withAlpha(150)]),
        borderRadius: BorderRadius.circular(8),
        boxShadow: [BoxShadow(color: color.withAlpha(60), blurRadius: 8, offset: const Offset(0, 2))],
      ),
      child: Text(
        text,
        style: const TextStyle(color: Colors.white, fontSize: 10, fontWeight: FontWeight.w900),
      ),
    );
  }

  Widget _buildSectionHeader(BuildContext context, String title, IconData icon) {
    final theme = Theme.of(context);
    return Row(
      children: [
        Icon(icon, size: 18, color: theme.colorScheme.primary),
        const SizedBox(width: 10),
        Text(
          title,
          style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w800),
        ),
      ],
    );
  }

  String _formatLeLing(dynamic rtime) {
    if (rtime == null) return '未知';
    final DateTime start = DateTime.fromMillisecondsSinceEpoch(int.tryParse(rtime.toString())! * 1000);
    final Duration diff = DateTime.now().difference(start);
    if (diff.inDays > 365) return '${(diff.inDays / 365).floor()} 年';
    if (diff.inDays > 30) return '${(diff.inDays / 30).floor()} 个月';
    return '${diff.inDays} 天';
  }

  String _formatDuration(dynamic minutes) {
    if (minutes == null) return '0 小时';
    final int m = int.tryParse(minutes.toString()) ?? 0;
    if (m > 60) return '${(m / 60).floor()} 小时 ${m % 60} 分钟';
    return '$m 分钟';
  }

  void _showLogoutDialog(BuildContext context, UserProvider userProvider) {
    CustomDialog.show(
      context,
      title: '确认退出登录',
      content: '退出登录将清空您的用户信息，但会保留设备关联信息。',
      confirmText: '退出登录',
      isDestructive: true,
    ).then((confirmed) {
      if (confirmed == true) {
        userProvider.logout();
      }
    });
  }
}
