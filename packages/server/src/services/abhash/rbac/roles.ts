import { and, eq } from "drizzle-orm";
import { db } from "../../../db";
import { organizationRole } from "../../../db/schema";
import {
	ac,
	adminRole,
	memberRole,
	ownerRole,
	type statements,
} from "../../../lib/access-control";

type Role = ReturnType<typeof ac.newRole>;
type Statements = typeof statements;
type Resource = keyof Statements;

/**
 * Resources whose actions apply to a project, environment or service, and
 * so can be granted per scope. Everything else is organization-level and
 * comes only from the member's organization role.
 */
export const SCOPED_RESOURCES = new Set<string>([
	"project",
	"environment",
	"service",
	"deployment",
	"domain",
	"envVars",
	"projectEnvVars",
	"environmentEnvVars",
	"volume",
	"backup",
	"volumeBackup",
	"schedule",
	"logs",
	"monitoring",
]);

/** A binding role that stands for the member's current organization role. */
export const ORG_ROLE = "@org";

const pick = (
	role: Partial<{ [R in Resource]: readonly Statements[R][number][] }>,
) => ac.newRole(role as never);

/**
 * Read-only access to what is in scope. No environment variables: they
 * routinely hold secrets.
 */
export const viewerRole = pick({
	project: [],
	environment: ["read"],
	service: ["read"],
	deployment: ["read"],
	domain: ["read"],
	volume: ["read"],
	backup: ["read"],
	volumeBackup: ["read"],
	schedule: ["read"],
	logs: ["read"],
	monitoring: ["read"],
	server: ["read"],
	tag: ["read"],
});

/** Builds and ships what is in scope; cannot delete the project or shell into hosts. */
export const developerRole = pick({
	environment: ["create", "read"],
	service: ["create", "read", "delete"],
	deployment: ["read", "create", "cancel"],
	domain: ["read", "create", "delete"],
	envVars: ["read", "write"],
	projectEnvVars: ["read", "write"],
	environmentEnvVars: ["read", "write"],
	volume: ["read", "create", "delete"],
	backup: ["read", "create", "update", "restore"],
	volumeBackup: ["read", "create", "update", "restore"],
	schedule: ["read", "create", "update", "delete"],
	logs: ["read"],
	monitoring: ["read"],
	server: ["read"],
	gitProviders: ["read"],
	registry: ["read"],
	certificate: ["read"],
	destination: ["read"],
	notification: ["read"],
	tag: ["read"],
});

/** Full control of what is in scope, including deleting it. */
export const scopeAdminRole = pick({
	project: ["delete"],
	environment: ["create", "read", "delete"],
	service: ["create", "read", "delete"],
	deployment: ["read", "create", "cancel"],
	domain: ["read", "create", "delete"],
	envVars: ["read", "write"],
	projectEnvVars: ["read", "write"],
	environmentEnvVars: ["read", "write"],
	volume: ["read", "create", "delete"],
	backup: ["read", "create", "update", "delete", "restore"],
	volumeBackup: ["read", "create", "update", "delete", "restore"],
	schedule: ["read", "create", "update", "delete"],
	logs: ["read"],
	monitoring: ["read"],
	server: ["read"],
	gitProviders: ["read"],
	registry: ["read"],
	certificate: ["read"],
	destination: ["read"],
	notification: ["read"],
	tag: ["read"],
});

export const BINDING_ROLES = {
	viewer: { role: viewerRole, label: "Viewer" },
	developer: { role: developerRole, label: "Developer" },
	"project-admin": { role: scopeAdminRole, label: "Project admin" },
} as const;

const ORG_ROLES: Record<string, Role> = {
	owner: ownerRole,
	admin: adminRole,
	member: memberRole,
};

export const isBuiltinRoleName = (name: string) =>
	name in ORG_ROLES || name in BINDING_ROLES || name === ORG_ROLE;

/** Resolves a role name (built-in or the organization's custom role). */
export const loadRole = async (
	name: string,
	organizationId: string,
): Promise<Role | null> => {
	if (ORG_ROLES[name]) return ORG_ROLES[name];
	if (name in BINDING_ROLES) {
		return BINDING_ROLES[name as keyof typeof BINDING_ROLES].role;
	}
	const rows = await db.query.organizationRole.findMany({
		where: and(
			eq(organizationRole.organizationId, organizationId),
			eq(organizationRole.role, name),
		),
	});
	if (rows.length === 0) return null;
	const merged: Record<string, Set<string>> = {};
	for (const row of rows) {
		for (const [resource, actions] of Object.entries(
			JSON.parse(row.permission) as Record<string, string[]>,
		)) {
			merged[resource] ??= new Set();
			for (const action of actions) merged[resource].add(action);
		}
	}
	return ac.newRole(
		Object.fromEntries(
			Object.entries(merged).map(([r, a]) => [r, [...a]]),
		) as never,
	);
};

export const roleGrants = (role: Role, resource: string, action: string) =>
	role.authorize({ [resource]: [action] } as never).success;
