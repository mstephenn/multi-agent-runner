import Database from "better-sqlite3";

/** Raw SQLite handle for tests that need to damage or back-date rows the Store API cannot (shared with the cli tests, which do not depend on better-sqlite3's types). */
export const openRaw = (path: string): Database.Database => new Database(path);
