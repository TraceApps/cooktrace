import { DatabaseSync } from 'node:sqlite';
const raw = new DatabaseSync(':memory:');
const db = {
  exec: sql => raw.exec(sql),
  prepare(sql) {
    const st = raw.prepare(sql);
    return {
      get: (...a) => st.get(...a),
      all: (...a) => st.all(...a),
      run: (...a) => { const r = st.run(...a); return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }; },
    };
  },
  transaction(fn) {
    return (...a) => { raw.exec('BEGIN'); try { const o = fn(...a); raw.exec('COMMIT'); return o; } catch (e) { raw.exec('ROLLBACK'); throw e; } };
  },
};
export default db;
