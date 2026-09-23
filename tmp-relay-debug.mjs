import http from 'node:http';
import { MediaServer } from './src/main/mediaTransport/mediaServer.ts';

const data = Buffer.from('0123456789abcdefghij', 'utf8');
const upstream = http.createServer((_req, res) => {
  console.log('[upstream] got req range=', JSON.stringify(_req.headers['range']));
  res.writeHead(200, { 'content-length': data.length, 'content-type': 'application/octet-stream' });
  res.end(data);
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', () => r()));
const addr = upstream.address();
console.log('[upstream] listening', addr);

const relay = new MediaServer({ bindHost: '127.0.0.1', log: (l, m) => console.log('[relay]', l, m) });
const relayPort = await relay.start(0);
const res = relay.registerResource({ source: { kind: 'http', url: `http://127.0.0.1:${addr.port}/song.mp3` }, mime: 'audio/mpeg', length: data.length }, 'rel');
console.log('[relay] port', relayPort, 'token', res?.token.slice(0, 6));

const headers = { Range: 'bytes=8-11' };
await new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: relayPort, path: `/res/${res?.token}`, method: 'GET', headers }, (r) => {
    console.log('[client] status', r.statusCode, 'headers', JSON.stringify(r.headers));
    const chunks = [];
    r.on('data', (c) => chunks.push(c));
    r.on('end', () => {
      console.log('[client] body', Buffer.concat(chunks).toString('utf8'));
      resolve();
    });
  });
  req.on('error', (e) => {
    console.log('[client] ERROR', e.code, e.message, e.rawPacket?.toString('utf8')?.slice(-40));
    reject(e);
  });
  req.end();
  setTimeout(() => {
    console.log('[client] TIMEOUT');
    req.destroy();
    resolve();
  }, 5000);
});
await relay.stop();
await new Promise((r) => upstream.close(() => r()));
console.log('done');
process.exit(0);