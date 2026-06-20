import type {
	AuditAction,
	AuditResourceType,
	NewAuditLog,
} from "../../db/schema";
import { db } from "../../db";
import { auditLog } from "../../db/schema";

export type AbhashAuditEvent = {
	organizationId?: string | null;
	userId?: string | null;
	userEmail: string;
	userRole: string;
	action: AuditAction;
	resourceType: AuditResourceType;
	resourceId?: string | null;
	resourceName?: string | null;
	metadata?: Record<string, unknown> | string | null;
};

const serializeMetadata = (
	metadata: AbhashAuditEvent["metadata"],
): string | null => {
	if (!metadata) {
		return null;
	}

	return typeof metadata === "string" ? metadata : JSON.stringify(metadata);
};

export const createAuditLog = async (event: AbhashAuditEvent) => {
	const payload: NewAuditLog = {
		organizationId: event.organizationId,
		userId: event.userId,
		userEmail: event.userEmail,
		userRole: event.userRole,
		action: event.action,
		resourceType: event.resourceType,
		resourceId: event.resourceId,
		resourceName: event.resourceName,
		metadata: serializeMetadata(event.metadata),
	};

	const [entry] = await db.insert(auditLog).values(payload).returning();
	return entry;
};
