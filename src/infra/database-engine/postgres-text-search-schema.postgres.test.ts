import path from "node:path";
import { getEnvironmentData } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { AGENT_TEXT_SEARCH_POSTGRES_SQL } from "../../state/openclaw-agent-text-search-migration.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../kysely-sync.js";
import { openNodeSqliteDatabase } from "../node-sqlite.js";
import { PostgresSyncConnection } from "../postgres-sync/connection.js";
import { publishSqliteDatabaseSchemaChange } from "../sqlite-database-admission.js";
import { admitStoreSearch } from "./adapters.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import type { SearchSchema, StoreSchema } from "./contract.js";
import { openPostgresEngineTestStore } from "./engine-store.test-support.js";

const configured = getEnvironmentData("openclaw.test.workboard.connection");
const connection = typeof configured === "string" ? configured : undefined;
const dirs = useAutoCleanupTempDirTracker(afterEach);
// The agent migration reads owner-persisted search extensions, so the store id is "agent".
const source: StoreSchema = {
  id: "agent",
  version: 37,
  sqlite: "",
  postgres:
    "CREATE TABLE notes (id TEXT PRIMARY KEY, ordinal BIGINT NOT NULL UNIQUE, text TEXT NOT NULL)",
};
const destination: StoreSchema = {
  ...source,
  version: 38,
  postgresTextSearchVersion: 2,
  postgresMigrations: [
    {
      version: 38,
      fromSchema: { postgres: source.postgres! },
      schema: { postgres: source.postgres!, postgresTextSearchVersion: 2 },
      sql: AGENT_TEXT_SEARCH_POSTGRES_SQL,
    },
  ],
};
const memory: SearchSchema = {
  mode: "keyword-only",
  text: { body: { table: "notes", fields: ["text"], postgres: { identity: "ordinal" } } },
};
const note =
  "Release went out on 2026-08-18 after the fix to server.py landed; the API serves /v1/models and the input/output schema is unchanged.";
const compound = ["08 18", "server", "models", "input output"];

describe.skipIf(!connection)("PostgreSQL full-text token split migration", () => {
  it("rebuilds admitted text indexes so existing rows match words inside compound tokens", () => {
    const anchor = openNodeSqliteDatabase(path.join(dirs.make("pg-text-search-"), "anchor.sqlite"));
    const opened: PostgresSyncConnection[] = [];
    const open = (schema: StoreSchema) => {
      const db = openPostgresEngineTestStore({
        anchor,
        schema,
        input: { connection: connection!, schemaPrefix: "text_split_test" },
        openSqlite() {
          throw new Error("Expected PostgreSQL");
        },
      });
      if (!(db instanceof PostgresSyncConnection)) {
        throw new Error("Expected PostgreSQL");
      }
      opened.push(db);
      return db;
    };
    const match = (db: PostgresSyncConnection, text: string) => {
      const search = admitStoreSearch(db, memory, { extension: "memory" });
      return executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<{ notes: { id: string } }>(db)
          .selectFrom("notes")
          .select("id")
          .where(search.fullText!.match(search.text.body!, { kind: "term", text })),
      ).rows;
    };
    const version = (db: PostgresSyncConnection) =>
      db.prepare("SELECT version FROM openclaw_schema_meta WHERE store = 'agent'").get()?.version;
    try {
      withEngineStoreAdmission(() => {
        const original = open(source);
        admitStoreSearch(original, memory, { extension: "memory" });
        original.runTransaction(() => {
          original.prepare("INSERT INTO notes VALUES (?, ?, ?)").run("deploy", 1, note);
        });
        expect(version(original)).toBe(37);
        // The historical generated column keeps "-08", "server.py", "/v1/models" whole.
        for (const text of ["Release", "server.py"]) {
          expect(match(original, text), text).toEqual([{ id: "deploy" }]);
        }
        for (const text of compound) {
          expect(match(original, text), text).toEqual([]);
        }
        publishSqliteDatabaseSchemaChange(anchor);
        const migrated = open(destination);
        expect(version(migrated)).toBe(38);
        for (const text of ["Release", "server.py", ...compound]) {
          expect(match(migrated, text), text).toEqual([{ id: "deploy" }]);
        }
        expect(match(migrated, "grocery")).toEqual([]);
        // The rebuilt catalog is exactly what fresh DDL produces: a reopen verifies the seal.
        publishSqliteDatabaseSchemaChange(anchor);
        const reopened = open(destination);
        expect(version(reopened)).toBe(38);
        expect(match(reopened, "server")).toEqual([{ id: "deploy" }]);
        expect(
          reopened
            .prepare(
              "SELECT indexname FROM pg_indexes WHERE schemaname = ? AND tablename = 'notes' ORDER BY indexname",
            )
            .all(reopened.schema)
            .map((row) => row.indexname),
        ).toContain("notes_search_gin");
      });
    } finally {
      withEngineStoreAdmission(() => {
        try {
          const original = opened[0];
          if (original) {
            original.exec(`DROP SCHEMA "${original.schema}" CASCADE`);
          }
        } finally {
          for (const db of opened) {
            db.close();
          }
          anchor.close();
        }
      });
    }
  });
});
