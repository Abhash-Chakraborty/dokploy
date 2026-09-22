import { execPooled } from "../ssh/pool";
import {
	type HostCronEntry,
	type NewHostCron,
	newManagedId,
	parseHostCron,
	readCommand,
	renderManagedFile,
	validateHostCron,
	writeCommand,
} from "./host-cron";

export * from "./host-cron";

const TIMEOUT_MS = 30_000;

const run = async (serverId: string, command: string) => {
	const result = await execPooled(serverId, command, { timeoutMs: TIMEOUT_MS });
	if (result.exitCode !== 0) {
		throw new Error(
			result.stderr.trim() || `exited with code ${result.exitCode}`,
		);
	}
	return result.stdout;
};

// Read-modify-write of one file: two edits to the same server must not
// interleave, or the second would drop the first.
const locks = new Map<string, Promise<unknown>>();
const serially = <T>(serverId: string, task: () => Promise<T>) => {
	const previous = locks.get(serverId) ?? Promise.resolve();
	const next = previous.catch(() => {}).then(task);
	locks.set(serverId, next);
	void next.finally(() => {
		if (locks.get(serverId) === next) locks.delete(serverId);
	});
	return next;
};

export const listHostCron = async (serverId: string) =>
	parseHostCron(await run(serverId, readCommand()));

const managedEntries = (entries: HostCronEntry[]) =>
	entries
		.filter((entry) => entry.managed && entry.managedId)
		.map((entry) => ({
			managedId: entry.managedId as string,
			name: entry.name ?? "",
			schedule: entry.schedule,
			user: entry.user ?? "root",
			command: entry.command,
		}));

export const addHostCron = (serverId: string, input: NewHostCron) =>
	serially(serverId, async () => {
		const problem = validateHostCron(input);
		if (problem) throw new Error(problem);
		const current = managedEntries(await listHostCron(serverId));
		const managedId = newManagedId();
		await run(
			serverId,
			writeCommand(
				renderManagedFile([
					...current,
					{
						...input,
						name: input.name.trim(),
						schedule: input.schedule.trim(),
						command: input.command.trim(),
						managedId,
					},
				]),
			),
		);
		return managedId;
	});

export const removeHostCron = (serverId: string, managedId: string) =>
	serially(serverId, async () => {
		const current = managedEntries(await listHostCron(serverId));
		const remaining = current.filter((entry) => entry.managedId !== managedId);
		if (remaining.length === current.length) {
			throw new Error("That cron job is not managed by Dokploy");
		}
		await run(serverId, writeCommand(renderManagedFile(remaining)));
	});
