import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../providers/persistence_provider.dart';
import '../widgets/song_card.dart';

class HistoryView extends StatelessWidget {
  const HistoryView({super.key});

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;

    return Scaffold(
      backgroundColor: Colors.transparent,
      body: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 40, vertical: 30),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '最近播放',
              style: TextStyle(
                fontSize: 28,
                fontWeight: FontWeight.w700,
                color: isDark ? Colors.white : Colors.black,
                letterSpacing: -0.5,
              ),
            ),
            const SizedBox(height: 24),
            Expanded(
              child: Consumer<PersistenceProvider>(
                builder: (context, persistence, _) {
                  final songs = persistence.history;
                  if (songs.isEmpty) return const Center(child: Text('暂无历史', style: TextStyle(color: Colors.white30)));
                  return ListView.builder(
                    itemCount: songs.length,
                    itemBuilder: (context, index) {
                      return SongCard(
                        song: songs[index],
                        playlist: songs,
                        showMore: true,
                      );
                    },
                  );
                },
              ),
            ),
          ],
        ),
      ),
    );
  }
}
