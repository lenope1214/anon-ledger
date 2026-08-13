'use strict';
/* Vercel 서버리스 진입점 — vercel.json이 /api/* 요청을 모두 이 함수로 rewrite한다. */
const core = require('../lib/core');

const hasDb = Boolean(process.env.DATABASE_URL || process.env.POSTGRES_URL);
if (hasDb) {
  core.setStore(require('../lib/store-pg')(core.normalizeLedger));
}

module.exports = async (req, res) => {
  if (!hasDb) {
    return core.sendJson(res, 500, {
      error: '데이터베이스가 연결되지 않았습니다. Vercel 프로젝트의 Storage 탭에서 Neon(Postgres)을 만들어 연결한 뒤 다시 배포하세요.',
    });
  }
  const url = new URL(req.url, 'http://localhost');
  return core.handleApi(req, res, url);
};
