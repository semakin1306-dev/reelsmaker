import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "./migrate.ts";

/**
 * Единственная точка открытия базы: включает внешние ключи, WAL и ожидание блокировки,
 * затем доводит схему до последней версии. Путь ":memory:" — база в памяти (для тестов).
 * Каталог файла создаётся при необходимости.
 */
export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
    migrate(db);
  } catch (e) {
    db.close();
    throw e;
  }
  return db;
}
