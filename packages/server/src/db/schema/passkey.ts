import {
	boolean,
	integer,
	pgTable,
	text,
	timestamp,
} from "drizzle-orm/pg-core";
import { nanoid } from "nanoid";
import { user } from "./user";

/**
 * WebAuthn passkey credentials, managed by the Better Auth `passkey` plugin.
 * Field names match the plugin's expected model (camelCase) so the Drizzle
 * adapter maps correctly.
 */
export const passkey = pgTable("passkey", {
	id: text("id")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	name: text("name"),
	publicKey: text("public_key").notNull(),
	userId: text("user_id")
		.notNull()
		.references(() => user.id, { onDelete: "cascade" }),
	credentialID: text("credential_id").notNull(),
	counter: integer("counter").notNull(),
	deviceType: text("device_type").notNull(),
	backedUp: boolean("backed_up").notNull(),
	transports: text("transports"),
	createdAt: timestamp("created_at").defaultNow(),
	aaguid: text("aaguid"),
});
