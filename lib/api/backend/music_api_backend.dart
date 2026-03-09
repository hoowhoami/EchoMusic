import '../../models/playlist.dart';
import '../../models/song.dart';

abstract class MusicApiBackend {
  Future<Map<String, dynamic>?> registerDevice() => throw UnimplementedError();

  Future<List<Song>> search(
    String keywords, {
    int page = 1,
    int pagesize = 30,
    String type = 'song',
  }) => throw UnimplementedError();

  Future<Map<String, dynamic>> getSearchResult(
    String keywords, {
    String type = 'song',
    int page = 1,
    int pagesize = 30,
  }) => throw UnimplementedError();

  Future<Map<String, dynamic>?> getSongUrl(
    String hash, {
    String quality = '',
  }) => throw UnimplementedError();

  Future<String?> getCloudSongUrl(String hash) => throw UnimplementedError();

  Future<List<Map<String, dynamic>>> getSongPrivilege(
    String hash, {
    String? albumId,
  }) => throw UnimplementedError();

  Future<Map<String, dynamic>> getSongRanking(dynamic albumAudioId) =>
      throw UnimplementedError();

  Future<Map<String, dynamic>> getSongRankingFilter(
    dynamic albumAudioId, {
    int page = 1,
    int pagesize = 30,
  }) => throw UnimplementedError();

  Future<Map<String, dynamic>> getFavoriteCount(String mixSongIds) =>
      throw UnimplementedError();

  Future<Map<String, dynamic>> getCommentCount(
    String hash, {
    String? specialId,
  }) => throw UnimplementedError();

  Future<Map<String, dynamic>> getMusicComments(
    dynamic mixSongId, {
    int page = 1,
    int pagesize = 30,
    int sort = 2,
    bool showClassify = false,
    bool showHotwordList = false,
  }) => throw UnimplementedError();

  Future<Map<String, dynamic>> getMusicClassifyComments(
    dynamic mixSongId,
    int typeId, {
    int page = 1,
    int pagesize = 30,
    int sort = 2,
  }) => throw UnimplementedError();

  Future<Map<String, dynamic>> getMusicHotwordComments(
    dynamic mixSongId,
    String hotWord, {
    int page = 1,
    int pagesize = 30,
    int sort = 2,
  }) => throw UnimplementedError();

  Future<List<Song>> getNewSongs() => throw UnimplementedError();

  Future<List<Map<String, dynamic>>> getRanks() => throw UnimplementedError();

  Future<List<Map<String, dynamic>>> getRankTop() => throw UnimplementedError();

  Future<List<Song>> getRankSongs(int rankId) => throw UnimplementedError();

  Future<List<Playlist>> getRecommendPlaylists() => throw UnimplementedError();

  Future<Map<String, dynamic>?> getPlaylistDetail(String ids) =>
      throw UnimplementedError();

  Future<Map<String, dynamic>> getPlaylistTrackAll(
    String id, {
    int page = 1,
    int pagesize = 30,
  }) => throw UnimplementedError();

  Future<Map<String, dynamic>> getPlaylistTrackAllNew(
    int listid, {
    int page = 1,
    int pagesize = 200,
  }) => throw UnimplementedError();

  Future<Map<String, dynamic>?> searchLyric(String hash) =>
      throw UnimplementedError();

  Future<Map<String, dynamic>?> getLyric(String id, String accesskey) =>
      throw UnimplementedError();

  Future<Map<String, dynamic>?> getSingerDetail(int id) =>
      throw UnimplementedError();

  Future<List<Song>> getSingerSongs(
    int id, {
    int page = 1,
    int pagesize = 200,
    String sort = 'hot',
  }) => throw UnimplementedError();

  Future<bool> followSinger(int id) => throw UnimplementedError();

  Future<bool> unfollowSinger(int id) => throw UnimplementedError();

  Future<Map<String, dynamic>?> getAlbumDetail(int id) =>
      throw UnimplementedError();

  Future<List<Song>> getAlbumSongs(int id, {int page = 1, int pagesize = 50}) =>
      throw UnimplementedError();

  Future<Map<String, dynamic>> getAlbumTop() => throw UnimplementedError();

  Future<bool> captchaSent(String mobile) => throw UnimplementedError();

  Future<Map<String, dynamic>> loginCellphone(
    String mobile,
    String code, {
    int? userid,
  }) => throw UnimplementedError();

  Future<Map<String, dynamic>?> loginQrKey() => throw UnimplementedError();

  Future<Map<String, dynamic>?> loginQrCreate(String key) =>
      throw UnimplementedError();

  Future<Map<String, dynamic>?> loginQrCheck(String key) =>
      throw UnimplementedError();

  Future<Map<String, dynamic>?> loginWxCreate() => throw UnimplementedError();

  Future<dynamic> loginWxCheck(String uuid) => throw UnimplementedError();

  Future<Map<String, dynamic>> loginOpenPlat(String code) =>
      throw UnimplementedError();

  Future<Map<String, dynamic>?> userDetail() => throw UnimplementedError();

  Future<Map<String, dynamic>?> userVipDetail() => throw UnimplementedError();

  Future<List<Map<String, dynamic>>> getUserFollow() =>
      throw UnimplementedError();

  Future<Map<String, dynamic>> getUserPlayHistory({String? bp}) =>
      throw UnimplementedError();

  Future<bool> uploadPlayHistory(int mixSongId) => throw UnimplementedError();

  Future<Map<String, dynamic>> getUserCloud({
    int page = 1,
    int pagesize = 30,
  }) => throw UnimplementedError();

  Future<Map<String, dynamic>> getUserPlaylistsRaw({
    int page = 1,
    int pagesize = 30,
  }) => throw UnimplementedError();

  Future<bool> addPlaylist(
    String name, {
    int isPri = 0,
    int type = 0,
    int? listCreateUserid,
    int? listCreateListid,
    String? listCreateGid,
    int source = 1,
  }) => throw UnimplementedError();

  Future<bool> deletePlaylist(int listid) => throw UnimplementedError();

  Future<bool> addPlaylistTrack(dynamic listid, String data) =>
      throw UnimplementedError();

  Future<bool> deletePlaylistTrack(dynamic listid, String fileids) =>
      throw UnimplementedError();

  Future<List<Map<String, dynamic>>> getPlaylistCategory() =>
      throw UnimplementedError();

  Future<List<Playlist>> getPlaylistByCategory(
    String categoryId, {
    int withsong = 0,
    int withtag = 1,
  }) => throw UnimplementedError();

  Future<String> getSearchDefault() => throw UnimplementedError();

  Future<List<String>> getSearchHot() => throw UnimplementedError();

  Future<List<Map<String, dynamic>>> getSearchHotCategorized() =>
      throw UnimplementedError();

  Future<List<Map<String, dynamic>>> getSearchSuggest(String keywords) =>
      throw UnimplementedError();

  Future<List<Song>> getEverydayRecommend() => throw UnimplementedError();

  Future<List<Map<String, dynamic>>> getTopIP() => throw UnimplementedError();

  Future<List<Map<String, dynamic>>> getIPData(
    int id, {
    String type = '',
    int page = 1,
    int pagesize = 30,
  }) => throw UnimplementedError();

  Future<List<Map<String, dynamic>>> getTopPlaylistByIP(
    int id, {
    int page = 1,
    int pagesize = 30,
  }) => throw UnimplementedError();

  Future<List<Song>> getSongClimax(String hash) => throw UnimplementedError();

  Future<List<Map<String, dynamic>>> getSongClimaxRaw(String hash) =>
      throw UnimplementedError();

  Future<bool> claimDayVip(String day) => throw UnimplementedError();

  Future<bool> upgradeDayVip() => throw UnimplementedError();

  Future<Map<String, dynamic>> getVipMonthRecord() =>
      throw UnimplementedError();

  Future<void> syncAuthCookie(String? cookie) async {}

  Future<void> dispose() async {}
}
