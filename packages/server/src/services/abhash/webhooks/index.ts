import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../db";
import { abhashWebhook, type WebhookEvent } from "../../../db/schema";
import { enqueueJob } from "../jobs/queue";
import { defineJob } from "../jobs/registry";
import { resolveSecretRefs } from "../vault/secrets";

export const signPayload = (secret: string, body: string) =>
	`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

/** For a receiver to verify a delivery; exported so tests use the real path. */
export const verifySignature = (
	secret: string,
	body: string,
	signature: string,
) => {
	const expected = Buffer.from(signPayload(secret, body));
	const given = Buffer.from(signature);
	return expected.length === given.length && timingSafeEqual(expected, given);
};

export const deliverWebhookJob = defineJob({
	type: "webhook.deliver",
	queue: "abhash-infra",
	input: z.object({
		webhookId: z.string(),
		event: z.string(),
		payload: z.record(z.string(), z.unknown()),
		sentAt: z.string(),
	}),
	title: (input) => `Deliver ${input.event}`,
	attempts: 4,
	timeoutMs: 60_000,
	run: async ({ input, log, redact }) => {
		const webhook = await db.query.abhashWebhook.findFirst({
			where: eq(abhashWebhook.id, input.webhookId),
		});
		if (!webhook || !webhook.enabled) return { skipped: true };
		const secret =
			(await resolveSecretRefs(webhook.secretRef, {
				organizationId: webhook.organizationId,
				projectId: webhook.organizationId,
			})) ?? webhook.secretRef;
		redact(secret);
		const body = JSON.stringify({
			event: input.event,
			sentAt: input.sentAt,
			organizationId: webhook.organizationId,
			data: input.payload,
		});
		const response = await fetch(webhook.url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-dokploy-event": input.event,
				"x-dokploy-signature": signPayload(secret, body),
			},
			body,
			signal: AbortSignal.timeout(20_000),
		});
		await db
			.update(abhashWebhook)
			.set({
				lastStatus: response.status,
				lastDeliveredAt: new Date(),
				lastError: response.ok ? null : await response.text().catch(() => null),
			})
			.where(eq(abhashWebhook.id, webhook.id));
		await log(`${webhook.url} -> ${response.status}`);
		if (!response.ok) {
			// Throwing retries with the job engine's backoff.
			throw new Error(`The receiver answered ${response.status}`);
		}
		return { status: response.status };
	},
});

/**
 * Fans an event out to the webhooks subscribed to it. Never throws: an
 * unreachable receiver must not fail the work that produced the event.
 */
export const emitEvent = async (
	organizationId: string | null,
	event: WebhookEvent,
	payload: Record<string, unknown>,
) => {
	if (!organizationId) return 0;
	try {
		const hooks = await db.query.abhashWebhook.findMany({
			where: and(
				eq(abhashWebhook.organizationId, organizationId),
				eq(abhashWebhook.enabled, true),
			),
		});
		const matching = hooks.filter((hook) => hook.events.includes(event));
		for (const hook of matching) {
			await enqueueJob(
				"webhook.deliver",
				{
					webhookId: hook.id,
					event,
					payload,
					sentAt: new Date().toISOString(),
				},
				{ actor: { type: "system" }, organizationId },
			).catch(() => null);
		}
		return matching.length;
	} catch {
		return 0;
	}
};
