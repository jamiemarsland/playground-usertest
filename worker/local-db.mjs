// The database binding a worker gets on Spacefast, on top of node:sqlite, so
// the tests and the local server run the real statements against a real SQL
// engine — including the ones a mock would happily accept and a database would
// not. ':memory:' for the tests; a file for the local server.
import { DatabaseSync } from 'node:sqlite';

export function localDb(file = ':memory:') {
  const db = new DatabaseSync(file);
  const prepare = (sql) => {
    let args = [];
    const stmt = {
      bind(...a) { args = a; return stmt; },
      async run() { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async first() { const r = db.prepare(sql).get(...args); return r === undefined ? null : r; },
    };
    return stmt;
  };
  return {
    prepare,
    async batch(stmts) { const out = []; for (const st of stmts) out.push(await st.run()); return out; },
  };
}
