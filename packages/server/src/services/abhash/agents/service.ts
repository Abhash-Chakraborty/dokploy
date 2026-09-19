import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "../../../db";
import {
	type AbhashApprovalMode,
	abhashAgent,
	abhashApiKeyPolicy,
	apikey,
	member,
	user,
} from "../../../db/schema";
import { createApiKey } from "../../user";
import { forgetAgentCache } from "./actor";
import { forgetKeyPolicy } from "./policy";

export type Agent = typeof abhashAgent.$inferSelect;

/** An address that cannot receive mail and cannot be signed in to. */
const serviceAccountEmail = (organizationId: string) =>
	`agent-${nanoid(10).toLowerCase()}.${organizationId.slice(0, 8)}@agents.invalid`;

export const listAgents = async (organizationId: string) => {
	const agents = await db.query.abhashAgent.findMany({
		where: eq(abhashAgent.organizationId, organizationId),
		orderBy: [desc(abhashAgent.createdAt)],
	});
	return Promise.all(
		agents.map(async (agent) => ({
			...agent,
			keys: await db.query.apikey.findMany({
				where: eq(apikey.referenceId, agent.userId),
				columns: {
					id: true,
					name: true,
					start: true,
					enabled: true,
					lastRequest: true,
					expiresAt: true,
					createdAt: true,
				},
			}),
		})),
	);
};

export const createAgent = async (input: {
	organizationId: string;
	name: string;
	description?: string;
	role: "member" | "admin";
	createdBy: string;
}) => {
	const userId = `agent-${nanoid(16)}`;
	return db.transaction(async (tx) => {
		await tx.insert(user).values({
			id: userId,
			name: input.name,
			email: serviceAccountEmail(input.organizationId),
			emailVerified: false,
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);
		await tx.insert(member).values({
			id: nanoid(),
			organizationId: input.organizationId,
			userId,
			role: input.role,
			createdAt: new Date(),
		} as never);
		const [agent] = await tx
			.insert(abhashAgent)
			.values({
				organizationId: input.organizationId,
				userId,
				name: input.name,
				description: input.description ?? "",
				createdBy: input.createdBy,
			})
			.returning();
		forgetAgentCache();
		return agent as Agent;
	});
};

export const findAgent = async (organizationId: string, id: string) => {
	const agent = await db.query.abhashAgent.findFirst({
		where: and(
			eq(abhashAgent.id, id),
			eq(abhashAgent.organizationId, organizationId),
		),
	});
	if (!agent) throw new Error("Agent not found");
	return agent;
};

export const updateAgent = async (
	organizationId: string,
	id: string,
	values: { name?: string; description?: string; enabled?: boolean },
) => {
	const agent = await findAgent(organizationId, id);
	await db.update(abhashAgent).set(values).where(eq(abhashAgent.id, agent.id));
	forgetAgentCache();
	return findAgent(organizationId, id);
};

/** Deleting the service account takes its keys and bindings with it. */
export const deleteAgent = async (organizationId: string, id: string) => {
	const agent = await findAgent(organizationId, id);
	await db.delete(user).where(eq(user.id, agent.userId));
	forgetAgentCache();
	return true;
};

export interface KeyPolicyInput {
	readOnly: boolean;
	allow: string[];
	ipAllowList: string[];
	approvalMode: AbhashApprovalMode;
}

export const issueAgentKey = async (input: {
	organizationId: string;
	agentId: string;
	name: string;
	expiresInDays?: number | null;
	policy: KeyPolicyInput;
}) => {
	const agent = await findAgent(input.organizationId, input.agentId);
	const key = await createApiKey(agent.userId, {
		name: input.name,
		prefix: "dkp_agent",
		expiresIn: input.expiresInDays
			? input.expiresInDays * 24 * 60 * 60
			: undefined,
		metadata: { organizationId: input.organizationId },
	});
	await db
		.insert(abhashApiKeyPolicy)
		.values({
			keyId: key.id,
			organizationId: input.organizationId,
			agentId: agent.id,
			...input.policy,
		})
		.onConflictDoUpdate({
			target: abhashApiKeyPolicy.keyId,
			set: input.policy,
		});
	forgetKeyPolicy(key.id);
	return key;
};

export const setKeyPolicy = async (
	organizationId: string,
	keyId: string,
	policy: KeyPolicyInput,
) => {
	await db
		.insert(abhashApiKeyPolicy)
		.values({ keyId, organizationId, ...policy })
		.onConflictDoUpdate({
			target: abhashApiKeyPolicy.keyId,
			set: policy,
		});
	forgetKeyPolicy(keyId);
	return true;
};

export const revokeAgentKey = async (
	organizationId: string,
	agentId: string,
	keyId: string,
) => {
	const agent = await findAgent(organizationId, agentId);
	const key = await db.query.apikey.findFirst({
		where: and(eq(apikey.id, keyId), eq(apikey.referenceId, agent.userId)),
	});
	if (!key) throw new Error("Key not found");
	await db.delete(apikey).where(eq(apikey.id, keyId));
	await db
		.delete(abhashApiKeyPolicy)
		.where(eq(abhashApiKeyPolicy.keyId, keyId));
	forgetKeyPolicy(keyId);
	return true;
};
