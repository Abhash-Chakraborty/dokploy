import * as schema from "@dokploy/server/db/schema";
import { CREDENTIAL_COLUMNS } from "@dokploy/server/services/abhash/vault/credentials";
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

const tables = new Map<string, PgTable>();
for (const value of Object.values(schema) as unknown[]) {
	if (is(value, PgTable)) tables.set(getTableName(value), value);
}

/**
 * The backfill rewrites these columns to ciphertext. A column it converts
 * but whose type still reads plain text hands that ciphertext to whoever
 * uses it, which is how Pushover would have been sent "enc:v1:…" as a token.
 */
describe("every column the backfill encrypts is read back decrypted", () => {
	for (const entry of CREDENTIAL_COLUMNS) {
		for (const column of entry.columns) {
			it(`${entry.table}.${column}`, () => {
				const table = tables.get(entry.table);
				expect(table, `table ${entry.table}`).toBeDefined();
				const definition = Object.values(
					getTableColumns(table as PgTable),
				).find((candidate) => candidate.name === column);
				expect(definition, `column ${column}`).toBeDefined();
				expect(definition?.columnType).toBe("PgCustomColumn");
			});
		}
	}
});
