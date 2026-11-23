import {DatabaseSync} from 'node:sqlite';
import {randomBytes, randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';

export function openStorage(directory) {
  mkdirSync(directory, {recursive:true, mode:0o700});
  const db = new DatabaseSync(join(directory, 'vesna.sqlite'));
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS objects (path TEXT PRIMARY KEY, etag TEXT NOT NULL, metadata TEXT NOT NULL, body BLOB NOT NULL);
    CREATE TABLE IF NOT EXISTS secrets (name TEXT PRIMARY KEY, value BLOB NOT NULL);`);
  const header = db.prepare('SELECT etag,metadata FROM objects WHERE path=?');
  const retrieve = db.prepare('SELECT etag,metadata,body FROM objects WHERE path=?');
  const insert = db.prepare('INSERT INTO objects(path,etag,metadata,body) VALUES(?,?,?,?) ON CONFLICT(path) DO NOTHING');
  const update = db.prepare('UPDATE objects SET etag=?,metadata=?,body=? WHERE path=? AND etag=?');
  const replace = db.prepare('INSERT INTO objects(path,etag,metadata,body) VALUES(?,?,?,?) ON CONFLICT(path) DO UPDATE SET etag=excluded.etag,metadata=excluded.metadata,body=excluded.body');
  const metadata = row => ({etag:row.etag, customMetadata:JSON.parse(row.metadata)});

  const bucket = {
    head(path) {
      const row = header.get(path);
      return row ? metadata(row) : null;
    },
    get(path) {
      const row = retrieve.get(path);
      if (!row) return null;
      return {...metadata(row), body:row.body, json:() => JSON.parse(Buffer.from(row.body).toString('utf8'))};
    },
    put(path, value, options = {}) {
      const etag = randomUUID();
      const meta = JSON.stringify(options.customMetadata || {});
      const body = Buffer.from(value);
      let result;
      if (options.onlyIf?.etagMatches) result = update.run(etag, meta, body, path, options.onlyIf.etagMatches);
      else if (options.onlyIf?.etagDoesNotMatch === '*') result = insert.run(path, etag, meta, body);
      else result = replace.run(path, etag, meta, body);
      return result.changes ? {etag,customMetadata:options.customMetadata || {}} : null;
    }
  };
  db.prepare('INSERT OR IGNORE INTO secrets(name,value) VALUES(?,?)').run('vk-encryption', randomBytes(32));
  const key = Buffer.from(db.prepare('SELECT value FROM secrets WHERE name=?').get('vk-encryption').value).toString('base64');
  return {bucket, key, close:() => db.close()};
}
