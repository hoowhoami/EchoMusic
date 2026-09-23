/**
 * EchoMusic DLNA DIDL-Lite / XML 构建（design §5）。
 *
 * - SetAVTransportURI 的 CurrentURIMetaData 用 DIDL-Lite 携带标题、艺人、专辑、封面与
 *   res(protocolInfo/size/duration) 供设备显示。
 * - 封面使用受控资源 URL（MediaServer 令牌）。
 * - XML 转义必须覆盖所有元数据字段，防标题注入。
 * - 时长按键值对构造（UPnP time 类型：HH:MM:SS(.mmm)）。
 */

export interface DidlTrackMeta {
  title?: string;
  artist?: string;
  album?: string;
  coverUrl?: string;
  /** 目标 URL（受控资源令牌 URL 或设备直连 URL）。 */
  url: string;
  mime: string;
  size?: number;
  /** 秒 */
  durationSec?: number;
  /** op=00 无 seek / op=01 支持 seek（DLNA 字节级）。 */
  seekable?: boolean;
  /** DLNA 内容格式 profile（如 MP3/FLAC/AVI 等）；未知时传空交由设备协商。 */
  profile?: string;
  upnpClass?: string;
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** 秒 → UPnP time（HH:MM:SS(.mmm)，支持 0..999 毫秒）。 */
export function formatUpnpDuration(sec: number | undefined): string | undefined {
  if (sec === undefined || !Number.isFinite(sec) || sec < 0) return undefined;
  const totalMs = Math.round(sec * 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = ms === 0 ? '' : `.${String(ms).padStart(3, '0')}`;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${mm}`;
}

export function protocolInfo(
  mime: string,
  opts?: { seekable?: boolean; profile?: string },
): string {
  const pn = opts?.profile ? `DLNA.ORG_PN=${opts.profile};` : '';
  const op = `DLNA.ORG_OP=${opts?.seekable === false ? '00' : '01'};`;
  const ci = 'DLNA.ORG_CI=0';
  const flags = [pn, op, ci].filter(Boolean).join('');
  const mimeOut = mime || 'audio/*';
  return `http-get:*:${mimeOut}:${flags}`;
}

/** 构建 DIDL-Lite item 的完整 XML。 */
export function buildDidlLite(meta: DidlTrackMeta, parts?: string[]): string {
  const hasNoMeta =
    !meta.title && !meta.artist && !meta.album && !meta.coverUrl && !meta.size && !meta.durationSec;

  if (hasNoMeta && parts?.length === 0) {
    // 无有效元数据的空 DIDL：允许空串；为兼容仍输出受限空 item。
    return (
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ` +
      `xmlns:dc="http://purl.org/dc/elements/1.1/" ` +
      `xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" ` +
      `xmlns:dlna="urn:schemas-dlna-org:metadata-1-0/">` +
      `<item id="echo-0" parentID="0" restricted="1"><upnp:class>object.item.audioItem.musicTrack</upnp:class></item>` +
      `</DIDL-Lite>`
    );
  }

  const title = meta.title?.trim() ? escapeXml(meta.title.trim()) : 'Unknown';
  const artist = meta.artist?.trim() ? escapeXml(meta.artist.trim()) : '';
  const album = meta.album?.trim() ? escapeXml(meta.album.trim()) : '';
  const upnpClass = meta.upnpClass ?? 'object.item.audioItem.musicTrack';
  const duration = formatUpnpDuration(meta.durationSec);
  const size =
    meta.size !== undefined && Number.isFinite(meta.size) && meta.size >= 0
      ? String(meta.size)
      : undefined;

  let xml =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/" ` +
    `xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" ` +
    `xmlns:dlna="urn:schemas-dlna-org:metadata-1-0/">` +
    `<item id="echo-0" parentID="0" restricted="1">` +
    `<dc:title>${title}</dc:title>`;
  if (artist) xml += `<dc:creator>${artist}</dc:creator>`;
  if (album) xml += `<upnp:album>${album}</upnp:album>`;
  xml +=
    `<upnp:class>${escapeXml(upnpClass)}</upnp:class>` +
    `<res protocolInfo="${escapeXml(protocolInfo(meta.mime, { seekable: meta.seekable, profile: meta.profile }))}"` +
    (size ? ` size="${size}"` : '') +
    (duration ? ` duration="${duration}"` : '') +
    `>${escapeXml(meta.url)}</res>`;
  if (meta.coverUrl) {
    xml += `<upnp:albumArtURI>${escapeXml(meta.coverUrl)}</upnp:albumArtURI>`;
  }
  xml += `</item></DIDL-Lite>`;
  return xml;
}

/** UPnP action：构建 SOAP 请求体（用于 AVTransport / RenderingControl / ConnectionManager）。 */
export function buildSoapAction(
  serviceType: string,
  action: string,
  args: Record<string, string>,
): string {
  const argXml = Object.entries(args)
    .map(([name, value]) => `<${name}>${escapeXml(value)}</${name}>`)
    .join('');
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">` +
    `<s:Body>` +
    `<u:${action} xmlns:u="${escapeXml(serviceType)}">` +
    argXml +
    `</u:${action}>` +
    `</s:Body></s:Envelope>`
  );
}
