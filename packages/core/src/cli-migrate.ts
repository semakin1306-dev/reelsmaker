// npm run migrate — поднять базу из конфига (.env) до последней версии. Используется скриптом выката.
import { loadConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { appliedVersions } from "./migrate.ts";

try {
  const config = loadConfig();
  const db = openDb(config.dbPath);
  const versions = appliedVersions(db);
  db.close();
  console.log(`База ${config.dbPath}: версия схемы ${versions.at(-1) ?? 0}`);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}
