import { app, net, session, type Session } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EmbeddedCoverCache, EMBEDDED_COVER_SCHEME } from './embeddedCoverCache';
import log from '../logger';

let cache: EmbeddedCoverCache | undefined;
let protocolRegistered = false;
export const getEmbeddedCoverCache = () =>
  (cache ??= new EmbeddedCoverCache(path.join(app.getPath('userData'), 'embedded-covers')));

export function registerEmbeddedCoverProtocol(): void {
  if (protocolRegistered) return;
  protocolRegistered = true;
  const registered = new WeakSet<Session>();
  const register = (target: Session) => {
    if (registered.has(target)) return;
    registered.add(target);
    target.protocol.handle(EMBEDDED_COVER_SCHEME, async (request) => {
      if (request.method !== 'GET' && request.method !== 'HEAD')
        return new Response(null, { status: 405 });
      const image = await getEmbeddedCoverCache().resolve(request.url);
      if (!image) return new Response(null, { status: 404 });
      const response =
        request.method === 'HEAD'
          ? null
          : await net.fetch(pathToFileURL(image.filePath).href).catch(() => null);
      if (request.method !== 'HEAD' && !response?.ok) return new Response(null, { status: 404 });
      return new Response(response?.body ?? null, {
        headers: {
          'Content-Type': image.mime,
          'Content-Length': String(image.size),
          'Cache-Control': 'public, max-age=31536000, immutable',
          'Access-Control-Allow-Origin': '*',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    });
  };
  app.on('session-created', register);
  void app
    .whenReady()
    .then(() => register(session.defaultSession))
    .catch((error) => log.warn('[EmbeddedMetadata] Cover protocol registration failed:', error));
}
