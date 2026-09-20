import { ExecError } from "../../../utils/process/ExecError";
import { isFlagEnabled } from "../flags";
import { execPooled } from "./pool";

/**
 * Drop-in for upstream's execAsyncRemote. Returns null when the SSH layer is
 * off, so the original code path runs unchanged.
 */
export const execViaPool = async (
	serverId: string,
	command: string,
	onData?: (data: string) => void,
) => {
	if (!(await isFlagEnabled("fleet.ssh"))) return null;
	const result = await execPooled(serverId, command, {
		onData: (chunk) => onData?.(chunk),
	});
	if (result.exitCode !== 0) {
		throw new ExecError(
			`Remote command failed with exit code ${result.exitCode}`,
			{
				command,
				stdout: result.stdout,
				stderr: result.stderr,
				exitCode: result.exitCode,
				serverId,
			},
		);
	}
	return { stdout: result.stdout, stderr: result.stderr };
};
