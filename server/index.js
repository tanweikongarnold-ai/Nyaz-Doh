// HTTP server for the static client plus a WebSocket endpoint at /ws for game traffic.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { RoomManager } from './rooms.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
// three.js is served straight from node_modules so the game also works offline / on a LAN.
const VENDOR = { '/vendor/three/': path.join(ROOT, 'node_modules', 'three') };
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }
  let rel;
  try {
    rel = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (rel.endsWith('/')) rel += 'index.html';
  let base = PUBLIC_DIR;
  const prefix = Object.keys(VENDOR).find((pre) => rel.startsWith(pre));
  if (prefix) {
    base = VENDOR[prefix];
    rel = `/${rel.slice(prefix.length)}`;
    if (!rel.endsWith('.js')) {
      res.writeHead(403).end();
      return;
    }
  }
  const file = path.resolve(base, `.${rel}`);
  if (!file.startsWith(base + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'content-length': st.size,
      'cache-control': prefix ? 'public, max-age=86400' : 'no-cache',
    });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file).pipe(res);
  });
}

export function startServer({ port = 3000, host } = {}) {
  const manager = new RoomManager();
  const server = http.createServer(serveStatic);
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 8 * 1024 });

  wss.on('connection', (socket) => {
    socket.isAlive = true;
    socket.on('pong', () => {
      socket.isAlive = true;
    });
    socket.on('message', (data, isBinary) => {
      if (!isBinary) manager.handle(socket, data.toString());
    });
    socket.on('close', () => manager.socketClosed(socket));
    socket.on('error', () => {});
  });

  // Drop connections that stopped answering pings (closed laptop lids, dead wifi).
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.isAlive) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, 30_000);

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const close = () => new Promise((done) => {
        clearInterval(heartbeat);
        manager.shutdown();
        for (const socket of wss.clients) socket.terminate();
        wss.close(() => server.close(() => done()));
      });
      resolve({ server, wss, manager, port: server.address().port, close });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT) || 3000;
  startServer({ port, host: process.env.HOST }).then(({ port: actual }) => {
    console.log(`Illegal Soccer 3v3 running at http://localhost:${actual}`);
    console.log('Share your LAN address (or deploy it) so friends can join your room.');
  });
}
