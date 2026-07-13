export interface MigrationRunnerDependencies {
	close: () => Promise<void>;
	error: (message: string, error: unknown) => void;
	log: (message: string) => void;
	migrate: () => Promise<void>;
}

export const runMigration = async ({
	close,
	error,
	log,
	migrate,
}: MigrationRunnerDependencies) => {
	try {
		await migrate();
		log("Migration complete");
	} catch (migrationError) {
		error("Migration failed", migrationError);
		process.exitCode = 1;
		throw migrationError;
	} finally {
		await close();
	}
};
