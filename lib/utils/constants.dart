class AudioQuality {
  final String label;
  final String value;
  const AudioQuality(this.label, this.value);

  static const standard = AudioQuality('标准品质', '128');
  static const high = AudioQuality('HQ高品质', '320');
  static const lossless = AudioQuality('SQ无损品质', 'flac');

  static const options = [standard, high, lossless];
  
  static String getLabel(String value) {
    return options.firstWhere((o) => o.value == value, orElse: () => standard).label;
  }
}

class AudioEffect {
  final String label;
  final String value;
  const AudioEffect(this.label, this.value);

  static const none = AudioEffect('原声', 'none');
  static const piano = AudioEffect('钢琴音效', 'piano');
  static const acappella = AudioEffect('人声伴奏', 'acappella');
  static const subwoofer = AudioEffect('骨笛音效', 'subwoofer');
  static const ancient = AudioEffect('尤克里里', 'ancient');
  static const surnay = AudioEffect('唢呐音效', 'surnay');
  static const dj = AudioEffect('DJ音效', 'dj');
  static const viperTape = AudioEffect('蝰蛇母带', 'viper_tape');
  static const viperAtmos = AudioEffect('蝰蛇全景声', 'viper_atmos');
  static const viperClear = AudioEffect('蝰蛇超清', 'viper_clear');

  static const options = [
    none, piano, acappella, subwoofer, ancient, surnay, dj, viperTape, viperAtmos, viperClear
  ];

  static String getLabel(String value) {
    return options.firstWhere((o) => o.value == value, orElse: () => none).label;
  }
}

class PlaySpeed {
  static const options = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];
}
