'use strict';
/*
 * Vercel용 저장소 — Neon(Postgres)에 계정별 장부를 저장한다.
 *  - users(username PK, doc jsonb): 계정 레코드 {username, salt, hash, createdAt, ledger}
 *  - sessions(token_hash PK, username, expires_at): 로그인 세션
 * 예전 단일 사용자 시절의 ledger(id=1) 테이블 데이터는 첫 가입자에게 물려준다.
 * DATABASE_URL(또는 POSTGRES_URL) 환경변수가 필요하다.
 */
module.exports = function createPgStore(normalizeLedger) {
  const { neon } = require('@neondatabase/serverless');
  const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);
  let ready = false;

  async function init() {
    if (ready) return;
    await sql`CREATE TABLE IF NOT EXISTS users (username text PRIMARY KEY, doc jsonb NOT NULL)`;
    await sql`CREATE TABLE IF NOT EXISTS sessions (token_hash text PRIMARY KEY, username text NOT NULL, expires_at bigint NOT NULL)`;
    ready = true;
  }

  return {
    async getUser(key) {
      await init();
      const rows = await sql`SELECT doc FROM users WHERE username = ${key}`;
      return rows.length ? rows[0].doc : null;
    },

    async createUser(key, rec) {
      await init();
      const rows = await sql`INSERT INTO users (username, doc) VALUES (${key}, ${JSON.stringify(rec)}::jsonb)
                             ON CONFLICT (username) DO NOTHING RETURNING username`;
      return rows.length > 0;
    },

    async saveUser(key, rec) {
      await init();
      await sql`UPDATE users SET doc = ${JSON.stringify(rec)}::jsonb WHERE username = ${key}`;
    },

    async countUsers() {
      await init();
      const rows = await sql`SELECT count(*)::int AS n FROM users`;
      return rows[0].n;
    },

    async listUsers() {
      await init();
      // 관리자 목록용 — 무거운 장부는 빼고 가져온다
      const rows = await sql`SELECT doc - 'ledger' - 'salt' - 'hash' AS doc FROM users`;
      return rows.map((r) => r.doc);
    },

    async deleteUser(key) {
      await init();
      await sql`DELETE FROM users WHERE username = ${key}`;
    },

    async takeLegacyLedger() {
      await init();
      try {
        const rows = await sql`SELECT doc FROM ledger WHERE id = 1`;
        return rows.length ? normalizeLedger(rows[0].doc) : null;
      } catch (e) {
        return null; // 예전 테이블이 없으면 물려받을 데이터도 없다
      }
    },

    async getSession(th) {
      await init();
      const rows = await sql`SELECT username, expires_at FROM sessions WHERE token_hash = ${th}`;
      if (!rows.length) return null;
      const s = rows[0];
      if (!(Number(s.expires_at) > Date.now())) {
        await sql`DELETE FROM sessions WHERE token_hash = ${th}`;
        return null;
      }
      return { user: s.username, expiresAt: Number(s.expires_at) };
    },

    async putSession(th, key, expiresAt) {
      await init();
      await sql`DELETE FROM sessions WHERE expires_at < ${Date.now()}`;
      await sql`INSERT INTO sessions (token_hash, username, expires_at) VALUES (${th}, ${key}, ${expiresAt})
                ON CONFLICT (token_hash) DO UPDATE SET username = EXCLUDED.username, expires_at = EXCLUDED.expires_at`;
    },

    async deleteSession(th) {
      await init();
      await sql`DELETE FROM sessions WHERE token_hash = ${th}`;
    },

    async deleteUserSessions(key) {
      await init();
      await sql`DELETE FROM sessions WHERE username = ${key}`;
    },
  };
};
