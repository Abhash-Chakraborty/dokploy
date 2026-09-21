import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../db";
import {
	abhashServerFirewall,
	abhashServerMeta,
	server,
} from "../../../db/schema";
import { tryAcquire } from "../jobs/locks";
import { defineJob } from "../jobs/registry";
import { closeConnection, execPooled } from "../ssh/pool";
import { asRoot } from "../ssh/root";
import { emitEvent } from "../webhooks";
import {
	type CompileContext,
	type CompiledRule,
	compileRules,
	meshSubnetFor,
	wouldLockOut,
} from "./compile";
import {
	applyScript,
	confirmScript,
	inspectScript,
	type RenderedFirewall,
	render,
} from "./render";

export const ROLLBACK_SECONDS = 120;

export const contextFor = async (
	serverId: string,
	organizationId: string,
): Promise<CompileContext> => {
	const row = await db.query.server.findFirst({
		where: eq(server.serverId, serverId),
		columns: { port: true },
	});
	const meta = await db.query.abhashServerMeta.findFirst({
		where: eq(abhashServerMeta.serverId, serverId),
	});
	const meshSubnet = await meshSubnetFor(serverId);
	return {
		serverId,
		organizationId,
		sshPort: row?.port ?? 22,
		meshSubnet,
		// Dokploy reaches the server over the mesh or its public address; the
		// SSH rule must cover whichever it is.
		controlAddress: meta?.connectVia === "mesh" ? meshSubnet : null,
	};
};

export type FirewallPlan = {
	rules: CompiledRule[];
	rendered: RenderedFirewall;
	lockout: string | null;
	mode: "off" | "audit" | "enforce";
};

export const planFirewall = async (
	serverId: string,
	organizationId: string,
): Promise<FirewallPlan> => {
	const context = await contextFor(serverId, organizationId);
	const rules = await compileRules(context);
	const settings = await db.query.abhashServerFirewall.findFirst({
		where: eq(abhashServerFirewall.serverId, serverId),
	});
	return {
		rules,
		rendered: render(rules),
		lockout: wouldLockOut(rules, context),
		mode: settings?.mode ?? "off",
	};
};

export const ensureFirewallRow = async (
	serverId: string,
	organizationId: string,
) => {
	await db
		.insert(abhashServerFirewall)
		.values({ serverId, organizationId })
		.onConflictDoNothing();
	return db.query.abhashServerFirewall.findFirst({
		where: eq(abhashServerFirewall.serverId, serverId),
	});
};

/**
 * Applies a ruleset with a dead-man switch: the server rolls the change
 * back on its own unless Dokploy reconnects and confirms. A ruleset that
 * would cut Dokploy's own path is refused before anything runs.
 */
export const applyFirewall = async (
	serverId: string,
	organizationId: string,
	log: (line: string) => Promise<void> | void,
) => {
	const settings = await ensureFirewallRow(serverId, organizationId);
	if (settings?.mode !== "enforce") {
		throw new Error(
			`The firewall is in ${settings?.mode ?? "off"} mode for this server; switch it to enforce first`,
		);
	}
	const plan = await planFirewall(serverId, organizationId);
	if (plan.lockout) throw new Error(plan.lockout);

	await log(`Applying ${plan.rules.length} rules (hash ${plan.rendered.hash})`);
	await log(
		`A rollback is armed for ${ROLLBACK_SECONDS}s; it fires unless Dokploy can still reach this server`,
	);
	const applied = await execPooled(
		serverId,
		asRoot(
			applyScript(plan.rendered, {
				rollbackSeconds: ROLLBACK_SECONDS,
				defaultIncoming: "deny",
			}),
			"DOKPLOY_APPLY",
		),
		{ timeoutMs: 120_000 },
	);
	if (applied.exitCode !== 0 || !applied.stdout.includes("APPLIED")) {
		const reason = `Applying failed: ${applied.stderr.slice(0, 400) || applied.stdout.slice(0, 400)}`;
		// Without this the firewall page shows a server in enforce mode with no
		// rules and no reason, which reads as protected.
		await db
			.update(abhashServerFirewall)
			.set({ lastError: reason, updatedAt: new Date() })
			.where(eq(abhashServerFirewall.serverId, serverId));
		throw new Error(reason);
	}

	// A brand-new connection: if the rules broke SSH, this fails and the
	// rollback the server armed puts everything back.
	closeConnection(serverId);
	try {
		const confirmed = await execPooled(
			serverId,
			asRoot(confirmScript(), "DOKPLOY_CONFIRM"),
			{ timeoutMs: 30_000 },
		);
		if (!confirmed.stdout.includes("CONFIRMED")) {
			throw new Error("The server did not confirm");
		}
	} catch (error) {
		await db
			.update(abhashServerFirewall)
			.set({
				lastError: `Could not reach the server after applying; it is rolling back. ${error instanceof Error ? error.message : error}`,
				updatedAt: new Date(),
			})
			.where(eq(abhashServerFirewall.serverId, serverId));
		throw new Error(
			"Could not reach the server after applying the rules. It rolls itself back within two minutes; nothing else is needed.",
		);
	}

	await db
		.update(abhashServerFirewall)
		.set({
			appliedHash: plan.rendered.hash,
			appliedAt: new Date(),
			driftedAt: null,
			lastError: null,
			updatedAt: new Date(),
		})
		.where(eq(abhashServerFirewall.serverId, serverId));
	await log("Confirmed; the rollback is cancelled");
	return { hash: plan.rendered.hash, rules: plan.rules.length };
};

export const checkDrift = async (serverId: string, organizationId: string) => {
	const settings = await ensureFirewallRow(serverId, organizationId);
	if (!settings || settings.mode === "off") return { drift: false as const };
	const plan = await planFirewall(serverId, organizationId);
	const result = await execPooled(
		serverId,
		asRoot(inspectScript(), "DOKPLOY_INSPECT"),
		{ timeoutMs: 30_000 },
	);
	const live = Object.fromEntries(
		result.stdout
			.split("\n")
			.map((line) => line.split("="))
			.filter((parts) => parts.length === 2)
			.map(([key, value]) => [key as string, (value as string).trim()]),
	);
	const drift =
		settings.mode === "enforce" &&
		// "inactive" contains "active", so compare the word exactly.
		(live.HASH !== plan.rendered.hash || live.UFW !== "active");
	await db
		.update(abhashServerFirewall)
		.set({ driftedAt: drift ? new Date() : null, updatedAt: new Date() })
		.where(eq(abhashServerFirewall.serverId, serverId));
	if (drift && !settings.driftedAt) {
		await emitEvent(organizationId, "firewall.drift", { serverId, live });
	}
	return { drift, live, expected: plan.rendered.hash };
};

const LOCK_WAIT_MS = 15 * 60_000;

/** Two applies racing on one server would each disarm the other's rollback. */
const withServerLock = async <T>(
	serverId: string,
	signal: AbortSignal,
	run: () => Promise<T>,
): Promise<T> => {
	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		const lease = await tryAcquire(`firewall:${serverId}`, 1);
		if (lease) {
			try {
				return await run();
			} finally {
				await lease.release();
			}
		}
		if (signal.aborted) throw new Error("Cancelled");
		if (Date.now() > deadline) {
			throw new Error(
				"Another firewall change is still running on this server",
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 3_000));
	}
};

/**
 * Every server is still attempted, but a run where any of them failed is a
 * failed run. Returning normally marked it succeeded, so Activity reported a
 * firewall in place on servers that had none.
 */
export const summarizeApplyFailures = (
	results: Record<string, string>,
): string | null => {
	const failed = Object.entries(results).filter(([, outcome]) =>
		outcome.startsWith("failed:"),
	);
	if (failed.length === 0) return null;
	return `${failed.length} of ${Object.keys(results).length} server(s) failed: ${failed
		.map(([id, outcome]) => `${id} ${outcome.slice("failed: ".length).trim()}`)
		.join("; ")
		.slice(0, 800)}`;
};

export const firewallApplyJob = defineJob({
	type: "firewall.apply",
	queue: "abhash-infra",
	input: z.object({
		organizationId: z.string(),
		serverIds: z.array(z.string()).min(1).max(100),
	}),
	title: (input) => `Apply the firewall to ${input.serverIds.length} server(s)`,
	destructive: true,
	timeoutMs: 30 * 60_000,
	// One lock per server, taken as each is reached: a job-level lock can
	// only name one key, which left every server but the first unguarded.
	run: async ({ input, log, progress, signal }) => {
		const results: Record<string, string> = {};
		let done = 0;
		for (const serverId of input.serverIds) {
			try {
				const result = await withServerLock(serverId, signal, () =>
					applyFirewall(serverId, input.organizationId, log),
				);
				results[serverId] = `applied ${result.hash}`;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				results[serverId] = `failed: ${message}`;
				await log(`ERROR ${message}`);
			}
			done++;
			await progress((done / input.serverIds.length) * 100);
		}
		const failure = summarizeApplyFailures(results);
		if (failure) throw new Error(failure);
		return results;
	},
});

export const firewallDriftJob = defineJob({
	type: "firewall.check-drift",
	queue: "abhash-infra",
	input: z.object({ organizationId: z.string().optional() }),
	title: () => "Check the firewalls for drift",
	timeoutMs: 10 * 60_000,
	// Hourly, and almost always finds nothing. A run that did find drift
	// keeps its history so the evidence survives.
	ephemeral: (result) =>
		((result as { drifted?: string[] } | null)?.drifted?.length ?? 0) === 0,
	run: async ({ input, log }) => {
		const all = await db.query.abhashServerFirewall.findMany();
		const rows = input.organizationId
			? all.filter((row) => row.organizationId === input.organizationId)
			: all;
		const drifted: string[] = [];
		for (const row of rows) {
			if (row.mode === "off") continue;
			const result = await checkDrift(row.serverId, row.organizationId).catch(
				() => ({ drift: false as const }),
			);
			if (result.drift) {
				drifted.push(row.serverId);
				await log(`${row.serverId}: drifted from what Dokploy applied`);
			}
		}
		return { checked: rows.length, drifted };
	},
});
