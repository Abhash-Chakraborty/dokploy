import fs from "node:fs/promises";
import path from "node:path";
import { paths } from "../../../constants";

const MAX_CHUNK = 256 * 1024;

export const jobLogDir = () => path.join(paths().LOGS_PATH, "abhash-jobs");

export const jobLogPath = (jobId: string) => {
	if (!/^[\w-]+$/.test(jobId)) throw new Error("Invalid job id");
	return path.join(jobLogDir(), `${jobId}.log`);
};

export const redactText = (text: string, secrets: Iterable<string>) => {
	let out = text;
	for (const secret of secrets) {
		if (secret.length >= 4) out = out.split(secret).join("••••");
	}
	return out;
};

export const createJobLogger = (jobId: string, secrets: Set<string>) => {
	const file = jobLogPath(jobId);
	let ready: Promise<unknown> | null = null;
	// Appends are chained so lines keep their order under concurrent callers.
	let tail: Promise<unknown> = Promise.resolve();
	return (line: string) => {
		ready ??= fs.mkdir(jobLogDir(), { recursive: true });
		const text = redactText(line, secrets);
		const stamped = text
			.split(/\r?\n/)
			.filter((l, i, all) => l.length > 0 || i < all.length - 1)
			.map((l) => `${new Date().toISOString()} ${l}\n`)
			.join("");
		tail = tail.then(() => ready).then(() => fs.appendFile(file, stamped));
		return tail as Promise<void>;
	};
};

/** Reads the log from `offset`; the caller passes `nextOffset` back to follow it. */
export const readJobLog = async (jobId: string, offset = 0) => {
	const file = jobLogPath(jobId);
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(file, "r");
	} catch {
		return { text: "", nextOffset: offset, size: 0 };
	}
	try {
		const { size } = await handle.stat();
		const start = Math.min(Math.max(offset, 0), size);
		const length = Math.min(size - start, MAX_CHUNK);
		const buffer = Buffer.alloc(length);
		await handle.read(buffer, 0, length, start);
		return { text: buffer.toString("utf8"), nextOffset: start + length, size };
	} finally {
		await handle.close();
	}
};

export const removeJobLog = (jobId: string) =>
	fs.rm(jobLogPath(jobId), { force: true });
