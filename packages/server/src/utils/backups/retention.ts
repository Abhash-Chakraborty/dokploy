const CHECKSUM = ".sha256";

/**
 * Which files to delete so only the newest `keep` backups remain. A backup's
 * checksum goes with it, and checksums whose backup is already gone are
 * removed too: deleting only the backups left ~20 orphaned `.sha256` files a
 * day in the bucket.
 */
export const planRetention = (
	files: string[],
	keep: number,
	isBackup: (name: string) => boolean,
) => {
	const names = files.map((file) => file.trim()).filter(Boolean);
	const backups = names.filter(isBackup).sort().reverse();
	const kept = new Set(backups.slice(0, keep));
	const expired = backups.slice(keep);
	const orphans = names.filter(
		(name) =>
			name.endsWith(CHECKSUM) && !kept.has(name.slice(0, -CHECKSUM.length)),
	);
	return [...new Set([...expired, ...orphans])];
};
