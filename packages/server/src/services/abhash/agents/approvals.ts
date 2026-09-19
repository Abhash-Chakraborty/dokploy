import { and, desc, eq, lt } from "drizzle-orm";
import { db } from "../../../db";
import { abhashApproval } from "../../../db/schema";
import { createAuditLog } from "../audit-log";
import { enqueueJob } from "../jobs/queue";
import { getJobDefinition } from "../jobs/registry";
import type { Actor } from "./actor";
import { getKeyPolicy } from "./policy";

export const APPROVAL_TTL_MS = 24 * 60 * 60_000;

export type Approval = typeof abhashApproval.$inferSelect;

export class ApprovalRequiredError extends Error {
	constructor(public readonly approval: Approval) {
		super(
			`This action needs approval. Waiting for a person to review request ${approval.id}.`,
		);
	}
}

/** Whether this actor's key makes `type` wait for a person. */
export const needsApproval = async (actor: Actor, destructive: boolean) => {
	if (actor.type === "user" || actor.type === "system") return false;
	const policy = actor.keyId ? await getKeyPolicy(actor.keyId) : null;
	const mode = policy?.approvalMode ?? "destructive";
	if (mode === "none") return false;
	if (mode === "all") return true;
	return destructive;
};

export const createApproval = async (input: {
	organizationId: string;
	actor: Actor;
	operation: string;
	summary: string;
	payload: Record<string, unknown>;
}) => {
	const [row] = await db
		.insert(abhashApproval)
		.values({
			organizationId: input.organizationId,
			requester: input.actor,
			operation: input.operation,
			summary: input.summary,
			input: input.payload,
			expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
		})
		.returning();
	if (!row) throw new Error("Could not record the approval request");
	await createAuditLog({
		organizationId: input.organizationId,
		// The actor id is an agent, not a user row, so it goes in metadata.
		userId: null,
		userEmail: input.actor.name ?? input.actor.type,
		userRole: input.actor.type,
		action: "create",
		resourceType: "approval",
		resourceId: row.id,
		resourceName: input.summary,
		metadata: {
			operation: input.operation,
			actorType: input.actor.type,
			actorId: input.actor.id,
			apiKeyId: input.actor.keyId,
		},
	});
	return row;
};

const expireStale = () =>
	db
		.update(abhashApproval)
		.set({ status: "expired" })
		.where(
			and(
				eq(abhashApproval.status, "pending"),
				lt(abhashApproval.expiresAt, new Date()),
			),
		);

export const listApprovals = async (
	organizationId: string,
	status?: Approval["status"],
) => {
	await expireStale();
	return db.query.abhashApproval.findMany({
		where: and(
			eq(abhashApproval.organizationId, organizationId),
			...(status ? [eq(abhashApproval.status, status)] : []),
		),
		orderBy: [desc(abhashApproval.createdAt)],
		limit: 100,
	});
};

export const getApproval = async (organizationId: string, id: string) => {
	await expireStale();
	return db.query.abhashApproval.findFirst({
		where: and(
			eq(abhashApproval.id, id),
			eq(abhashApproval.organizationId, organizationId),
		),
	});
};

/**
 * Runs exactly the request that was recorded, attributed to both the agent
 * that asked and the person who approved it. The stored input is never
 * merged with anything the agent sends later.
 */
export const decideApproval = async (input: {
	organizationId: string;
	id: string;
	approve: boolean;
	decidedBy: { id: string; email: string; role: string };
	reason?: string;
}) => {
	const approval = await getApproval(input.organizationId, input.id);
	if (!approval) throw new Error("Approval not found");
	if (approval.status !== "pending") {
		throw new Error(`This request is already ${approval.status}`);
	}
	const decided = {
		decidedBy: input.decidedBy.id,
		decidedAt: new Date(),
		reason: input.reason ?? null,
	};
	if (!input.approve) {
		await db
			.update(abhashApproval)
			.set({ ...decided, status: "rejected" })
			.where(eq(abhashApproval.id, approval.id));
	} else {
		const definition = getJobDefinition(approval.operation);
		if (!definition) throw new Error(`Unknown operation ${approval.operation}`);
		try {
			const job = await enqueueJob(approval.operation, approval.input, {
				actor: {
					...approval.requester,
					name: `${approval.requester.name ?? approval.requester.type} (approved by ${input.decidedBy.email})`,
				},
				organizationId: approval.organizationId,
			});
			await db
				.update(abhashApproval)
				.set({ ...decided, status: "executed", jobId: job.id })
				.where(eq(abhashApproval.id, approval.id));
		} catch (error) {
			await db
				.update(abhashApproval)
				.set({
					...decided,
					status: "failed",
					reason: error instanceof Error ? error.message : String(error),
				})
				.where(eq(abhashApproval.id, approval.id));
			throw error;
		}
	}
	await createAuditLog({
		organizationId: input.organizationId,
		userId: input.decidedBy.id,
		userEmail: input.decidedBy.email,
		userRole: input.decidedBy.role,
		action: "update",
		resourceType: "approval",
		resourceId: approval.id,
		resourceName: approval.summary,
		metadata: { approved: input.approve, reason: input.reason },
	});
	return getApproval(input.organizationId, input.id);
};

/**
 * Enqueues a job, or records an approval request when the actor's key says
 * a person has to see it first. Every phase that runs infrastructure work
 * goes through here instead of calling enqueueJob directly.
 */
export const enqueueJobForActor = async (
	type: string,
	input: unknown,
	options: { actor: Actor; organizationId: string },
) => {
	const definition = getJobDefinition(type);
	if (!definition) throw new Error(`Unknown job type: ${type}`);
	const parsed = definition.input.parse(input);
	const destructive =
		typeof definition.destructive === "function"
			? definition.destructive(parsed)
			: (definition.destructive ?? false);
	if (await needsApproval(options.actor, destructive)) {
		const approval = await createApproval({
			organizationId: options.organizationId,
			actor: options.actor,
			operation: type,
			summary: definition.title(parsed),
			payload: parsed as Record<string, unknown>,
		});
		return { approval, job: null };
	}
	const job = await enqueueJob(type, parsed, {
		actor: options.actor,
		organizationId: options.organizationId,
	});
	return { approval: null, job };
};
