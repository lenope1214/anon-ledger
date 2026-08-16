#!/usr/bin/env node
/*
 * 거래장부 로컬 서버 — 외부 패키지 없이 Node.js 기본 모듈만 사용합니다.
 * 실행: node server.js  (Node.js 16 이상)
 * 공통 로직은 lib/core.js에 있고, Vercel 배포(api/index.js)와 공유합니다.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const core = require('./lib/core');
const createFileStore = require('./lib/store-file');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');

// DB 환경변수가 있으면 Neon Postgres, 없으면 로컬 파일에 저장한다.
// (Vercel이 이 파일을 통째로 실행하는 배포 방식이어도 DB를 쓰도록)
const hasDb = Boolean(process.env.DATABASE_URL || process.env.POSTGRES_URL);
const onVercel = process.env.VERCEL === '1';
if (hasDb) {
  core.setStore(require('./lib/store-pg')(core.normalizeLedger));
} else {
  core.setStore(createFileStore(DATA_DIR, core.normalizeLedger));
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, p) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Method Not Allowed');
  }
  const rel = p === '/' ? 'index.html' : p.slice(1);
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden');
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      // 항상 서버에 최신 여부를 확인하게 해서 배포 후 옛 화면이 남지 않게 한다
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    if (onVercel && !hasDb) {
      return core.sendJson(res, 500, {
        error: '데이터베이스가 연결되지 않았습니다. Vercel 프로젝트의 Storage 탭에서 Neon(Postgres)을 만들어 연결한 뒤 다시 배포하세요.',
      });
    }
    core.handleApi(req, res, url).catch((e) => core.sendJson(res, 500, { error: (e && e.message) || '서버 오류' }));
    return;
  }
  serveStatic(req, res, url.pathname);
});

server.listen(PORT, HOST, () => {
  console.log('📒 거래장부 서버가 시작되었습니다.');
  console.log(`  저장소: ${hasDb ? 'Neon Postgres (DATABASE_URL)' : '로컬 파일 (data/db.json)'}`);
  console.log(`  이 컴퓨터에서:  http://localhost:${PORT}`);
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) {
        console.log(`  휴대폰에서:     http://${i.address}:${PORT}  (같은 와이파이에 연결한 뒤 접속)`);
      }
    }
  }
  console.log('  종료하려면 Ctrl+C 를 누르세요.');
});
