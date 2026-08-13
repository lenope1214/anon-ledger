'use strict';
/*
 * 로컬 실행용 저장소 — data/db.json 파일 하나에 모든 계정과 세션을 저장한다.
 * 파일 형태: { users: { 아이디소문자: {username, salt, hash, createdAt, ledger} },
 *             sessions: { 토큰해시: { user, expiresAt } } }
 * 예전 단일 사용자 형식(최상위에 companies 등)을 만나면 legacy로 보관했다가
 * 첫 가입자에게 물려준다.
 */
const fs = require('fs');
const path = require('path');

module.exports = function createFileStore(dataDir, normalizeLedger) {
  const DB_FILE = path.join(dataDir, 'db.json');
  let cache = null;
  let legacy = null;

  function load() {
    if (cache) return cache;
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
      // 저장 파일이 없으면 새로 시작
    }
    if (parsed && typeof parsed.users === 'object' && parsed.users) {
      cache = { users: parsed.users, sessions: parsed.sessions || {} };
    } else {
      if (parsed && Array.isArray(parsed.companies)) legacy = parsed; // 예전 형식
      cache = { users: {}, sessions: {} };
    }
    return cache;
  }

  function persist() {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
    fs.renameSync(tmp, DB_FILE);
  }

  function pruneSessions() {
    const now = Date.now();
    for (const [k, s] of Object.entries(cache.sessions)) {
      if (!s || !(s.expiresAt > now)) delete cache.sessions[k];
    }
  }

  return {
    async getUser(key) {
      return load().users[key] || null;
    },

    async createUser(key, rec) {
      load();
      if (cache.users[key]) return false;
      cache.users[key] = rec;
      persist();
      return true;
    },

    async saveUser(key, rec) {
      load().users[key] = rec;
      persist();
    },

    async countUsers() {
      return Object.keys(load().users).length;
    },

    async listUsers() {
      // 관리자 목록용 — 무거운 장부와 해시는 빼고 돌려준다
      return Object.values(load().users).map((r) => ({
        username: r.username,
        createdAt: r.createdAt,
        status: r.status,
        isAdmin: r.isAdmin,
      }));
    },

    async deleteUser(key) {
      load();
      if (cache.users[key]) {
        delete cache.users[key];
        persist();
      }
    },

    async takeLegacyLedger() {
      load();
      return legacy ? normalizeLedger(legacy) : null;
    },

    async getSession(th) {
      load();
      const s = cache.sessions[th];
      if (!s) return null;
      if (!(s.expiresAt > Date.now())) {
        delete cache.sessions[th];
        persist();
        return null;
      }
      return s;
    },

    async putSession(th, key, expiresAt) {
      load();
      pruneSessions();
      cache.sessions[th] = { user: key, expiresAt };
      persist();
    },

    async deleteSession(th) {
      load();
      if (cache.sessions[th]) {
        delete cache.sessions[th];
        persist();
      }
    },

    async deleteUserSessions(key) {
      load();
      for (const [k, s] of Object.entries(cache.sessions)) {
        if (s && s.user === key) delete cache.sessions[k];
      }
      persist();
    },
  };
};
