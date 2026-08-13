'use strict';
/*
 * Vercel용 저장소 — Neon(Postgres)에 장부 전체를 jsonb 문서 한 건으로 저장한다.
 * DATABASE_URL(또는 POSTGRES_URL) 환경변수가 필요하다.
 */
module.exports = function createPgStore(normalizeDb) {
  const { neon } = require('@neondatabase/serverless');
  const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);
  let ready = false;

  async function init() {
    if (ready) return;
    await sql`CREATE TABLE IF NOT EXISTS ledger (id int PRIMARY KEY, doc jsonb NOT NULL)`;
    ready = true;
  }

  return {
    async load() {
      await init();
      const rows = await sql`SELECT doc FROM ledger WHERE id = 1`;
      if (!rows.length) {
        const fresh = normalizeDb(null);
        await sql`INSERT INTO ledger (id, doc) VALUES (1, ${JSON.stringify(fresh)}::jsonb) ON CONFLICT (id) DO NOTHING`;
        return fresh;
      }
      return normalizeDb(rows[0].doc);
    },

    async save(db) {
      await init();
      await sql`INSERT INTO ledger (id, doc) VALUES (1, ${JSON.stringify(db)}::jsonb)
                ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc`;
    },
  };
};
