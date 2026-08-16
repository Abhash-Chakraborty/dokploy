import { nanoid } from "nanoid";
import { quote } from "shell-quote";
import type { Destination } from "../../services/destination";
import { getS3Credentials } from "../backups/utils";
import { execAsync, execAsyncRemote } from "../process/execAsync";
import {
	buildDrillCommands,
	buildRestoreDrillScript,
	type DrillDatabaseType,
	parseRestoreDrill,
	type RestoreDrillResult,
	scratchDatabaseName,
} from "./drill";
import { getComposeSearchCommand } from "./utils";

export interface RestoreDrillInput {
	type: DrillDatabaseType;
	appName: string;
	databaseUser: string;
	databasePassword: string;
	/** Key of the dump inside the destination bucket. */
	backupFile: string;
	destination: Destination;
	serverId?: string | null;
}

/**
 * Restores a real backup into a throwaway database and reports whether it
 * actually worked. Nothing touches the live database.
 */
export const runRestoreDrill = async (
	input: RestoreDrillInput,
): Promise<RestoreDrillResult> => {
	const scratch = scratchDatabaseName(nanoid());
	const startedAt = Date.now();

	const rcloneFlags = getS3Credentials(input.destination);
	const backupPath = `:s3:${input.destination.bucket}/${input.backupFile}`;
	const rcloneCommand = `rclone cat ${rcloneFlags.join(" ")} ${quote([backupPath])} | gunzip`;

	const script = buildRestoreDrillScript({
		containerSearchCommand: getComposeSearchCommand(input.appName, "database"),
		rcloneCommand,
		commands: buildDrillCommands(input.type, scratch, {
			databaseUser: input.databaseUser,
			databasePassword: input.databasePassword,
		}),
	});

	try {
		const { stdout } = input.serverId
			? await execAsyncRemote(input.serverId, script)
			: await execAsync(script);
		return parseRestoreDrill(scratch, stdout, Date.now() - startedAt);
	} catch (error) {
		// A non-zero exit is the interesting case: it means the dump didn't
		// restore. Surface whatever the engine said rather than a generic error.
		const message =
			error instanceof Error ? error.message : "The drill could not run.";
		return {
			passed: false,
			detail: message.split("\n").slice(0, 4).join(" ").slice(0, 400),
			tableCount: 0,
			scratchDatabase: scratch,
			durationMs: Date.now() - startedAt,
		};
	}
};
