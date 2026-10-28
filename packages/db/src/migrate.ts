import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

export interface MigrateOptions {
  url: string;
  dir: string;
  direction: 'up' | 'down';
}

interface MigrationFile {
  version: string;
  up: string;
  down: string;
}

/** dbmate 格式: 文件内含 `-- migrate:up` 与 `-- migrate:down` 两个段落 */
function parseMigrationFile(content: string, file: string): { up: string; down: string } {
  const upIdx = content.search(/^-- migrate:up\s*$/m);
  if (upIdx < 0) throw new Error(`${file}: 缺少 "-- migrate:up" 标记`);
  const downIdx = content.search(/^-- migrate:down\s*$/m);
  const up = content
    .slice(upIdx, downIdx >= 0 ? downIdx : undefined)
    .replace(/^-- migrate:up[^\n]*\n/, '');
  const down =
    downIdx >= 0 ? content.slice(downIdx).replace(/^-- migrate:down[^\n]*\n/, '') : '';
  return { up, down };
}

function listMigrationFiles(dir: string): MigrationFile[] {
  if (!fs.existsSync(dir)) throw new Error(`migrations dir not found: ${dir} (相对进程 cwd)`);
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
  return files.map((f) => ({
    version: f,
    ...parseMigrationFile(fs.readFileSync(path.join(dir, f), 'utf8'), f),
  }));
}

export async function runMigrations(opts: MigrateOptions): Promise<string[]> {
  const client = new Client({ connectionString: opts.url });
  await client.connect();
  const changed: string[] = [];
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS lp_schema_migrations (
         version text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const { rows } = await client.query<{ version: string }>(
      'SELECT version FROM lp_schema_migrations',
    );
    const appliedSet = new Set(rows.map((r) => r.version));
    const files = listMigrationFiles(opts.dir);

    if (opts.direction === 'up') {
      for (const f of files) {
        if (appliedSet.has(f.version)) continue;
        await client.query('BEGIN');
        try {
          await client.query(f.up);
          await client.query('INSERT INTO lp_schema_migrations(version) VALUES ($1)', [
            f.version,
          ]);
          await client.query('COMMIT');
          changed.push(f.version);
          console.log(`migrate: applied ${f.version}`);
        } catch (e) {
          await client.query('ROLLBACK');
          throw new Error(`migration ${f.version} failed: ${(e as Error).message}`);
        }
      }
    } else {
      const done = files.filter((f) => appliedSet.has(f.version)).sort().reverse();
      const target = done[0];
      if (target) {
        await client.query('BEGIN');
        try {
          await client.query(target.down);
          await client.query('DELETE FROM lp_schema_migrations WHERE version = $1', [
            target.version,
          ]);
          await client.query('COMMIT');
          changed.push(target.version);
          console.log(`migrate: rolled back ${target.version}`);
        } catch (e) {
          await client.query('ROLLBACK');
          throw new Error(`rollback ${target.version} failed: ${(e as Error).message}`);
        }
      }
    }
  } finally {
    await client.end();
  }
  return changed;
}
