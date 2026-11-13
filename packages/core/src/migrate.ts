import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Каталог нумерованных SQL-файлов миграций: packages/core/migrations. */
export const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));

const FILE_RE = /^(\d{3,})_[\w-]+\.sql$/;

/** Читает миграции из каталога. Номера обязаны идти подряд с 1: дыра или повтор — ошибка. */
export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const list: Migration[] = files.map((f) => {
    const m = FILE_RE.exec(f);
    if (!m) throw new Error(`Файл миграции ${f}: имя должно быть вида 001_название.sql`);
    return { version: Number(m[1]), name: f.replace(/\.sql$/, ""), sql: readFileSync(join(dir, f), "utf8") };
  });
  list.forEach((m, i) => {
    const expected = i + 1;
    if (m.version !== expected) {
      throw new Error(`Миграции: ожидался номер ${String(expected).padStart(3, "0")}, найден ${m.name}`);
    }
  });
  return list;
}

export function latestVersion(dir: string = MIGRATIONS_DIR): number {
  return loadMigrations(dir).at(-1)?.version ?? 0;
}

function ensureVersionTable(db: DatabaseSync): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    INTEGER PRIMARY KEY,
       name       TEXT NOT NULL,
       applied_at TEXT NOT NULL
     )`,
  );
}

/** Применённые версии по возрастанию. */
export function appliedVersions(db: DatabaseSync): number[] {
  ensureVersionTable(db);
  return db
    .prepare("SELECT version FROM schema_migrations ORDER BY version")
    .all()
    .map((r) => Number(r["version"]));
}

/**
 * Доводит базу до последней версии. Каждая миграция — в своей транзакции:
 * при ошибке она откатывается целиком, версия не записывается. Повторный вызов безопасен.
 * Возвращает номера применённых сейчас версий.
 */
export function migrate(db: DatabaseSync, dir: string = MIGRATIONS_DIR): number[] {
  const all = loadMigrations(dir);
  const done = new Set(appliedVersions(db));
  const applied: number[] = [];
  for (const m of all) {
    if (done.has(m.version)) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        m.version,
        m.name,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      const reason = e instanceof Error ? e.message : String(e);
      throw new Error(`Миграция ${m.name} не применилась: ${reason}`, { cause: e });
    }
    applied.push(m.version);
  }
  return applied;
}
