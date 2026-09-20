import { eq } from "drizzle-orm";
import { db } from "../../../db";
import { type AbhashJobActor, abhashAgent } from "../../../db/schema";

export type Actor = AbhashJobActor & { keyId?: string };

type SessionLike = {
	user?: { id?: string; email?: string } | null;
	apiKey?: { id: string; name?: string | null } | null;
} | null;

const shared = globalThis as unknown as {
	__abhashAgentByUser?: Map<string, { id: string; name: string } | null>;
};
shared.__abhashAgentByUser ??= new Map();

const agentForUser = async (userId: string) => {
	const cached = shared.__abhashAgentByUser?.get(userId);
	if (cached !== undefined) return cached;
	const row = await db.query.abhashAgent.findFirst({
		where: eq(abhashAgent.userId, userId),
		columns: { id: true, name: true },
	});
	const value = row ?? null;
	shared.__abhashAgentByUser?.set(userId, value);
	return value;
};

export const forgetAgentCache = () => shared.__abhashAgentByUser?.clear();

/**
 * Who is making this request: a person in the UI, an API key, or an agent's
 * key. Audit entries, approvals and response redaction all key off this.
 */
export const resolveActor = async (session: SessionLike): Promise<Actor> => {
	const userId = session?.user?.id;
	if (!userId) return { type: "system" };
	const keyId = session?.apiKey?.id;
	if (!keyId) {
		return {
			type: "user",
			id: userId,
			name: session?.user?.email ?? undefined,
		};
	}
	const agent = await agentForUser(userId);
	return agent
		? { type: "agent", id: agent.id, name: agent.name, keyId }
		: {
				type: "apiKey",
				id: userId,
				name: session?.apiKey?.name ?? undefined,
				keyId,
			};
};

export const isHuman = (actor?: Actor | null) =>
	!actor || actor.type === "user";
