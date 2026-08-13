'use strict';
/* 로컬 실행용 저장소 — data/db.json 파일 하나에 장부 전체를 저장한다. */
const fs = require('fs');
const path = require('path');

module.exports = function createFileStore(dataDir, normalizeDb) {
  const DB_FILE = path.join(dataDir, 'db.json');
  let cache = null;

  return {
    async load() {
      if (!cache) {
        let parsed = null;
        try {
          parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        } catch (e) {
          // 저장 파일이 없으면 새 장부로 시작
        }
        cache = normalizeDb(parsed);
      }
      return cache;
    },

    async save(db) {
      cache = db;
      fs.mkdirSync(dataDir, { recursive: true });
      const tmp = DB_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
      fs.renameSync(tmp, DB_FILE);
    },
  };
};
