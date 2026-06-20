import type { AuditAction, AuditResourceType } from "@dokploy/server/db/schema";
import { createAuditLog } from "@dokploy/server/services/abhash/audit-log";

interface AuditCtx {
	user: { id: string; email: string; role: string };
	session: { activeOrganizationId: string };
	req?: {
		headers: {
			[key: string]: string | string[] | undefined;
		};
		method?: string;
		url?: string;
	};
}

interface AuditEvent {
	action: AuditAction;
	resourceType: AuditResourceType;
	resourceId?: string;
	resourceName?: string;
	metadata?: Record<string, unknown>;
}

const headerValue = (
	value: string | string[] | undefined,
): string | undefined => {
	if (Array.isArray(value)) {
		return value[0];
	}
	return value;
};

const requestMetadata = (ctx: AuditCtx) => ({
	ipAddress:
		headerValue(ctx.req?.headers["x-forwarded-for"])?.split(",")[0]?.trim() ||
		headerValue(ctx.req?.headers["x-real-ip"]) ||
		null,
	userAgent: headerValue(ctx.req?.headers["user-agent"]) || null,
	method: ctx.req?.method || null,
	path: ctx.req?.url || null,
});

/**
 * Creates an audit log entry from a tRPC context.
 * Extracts userId, userEmail, userRole and organizationId automatically.
 *
 * Usage:
 *   await audit(ctx, { action: "create", resourceType: "project", resourceName: "my-app" });
 */
export const audit = (ctx: AuditCtx, event: AuditEvent) =>
	createAuditLog({
		organizationId: ctx.session.activeOrganizationId,
		userId: ctx.user.id,
		userEmail: ctx.user.email,
		userRole: ctx.user.role,
		...event,
		metadata: {
			...requestMetadata(ctx),
			...(event.metadata ?? {}),
		},
	});
