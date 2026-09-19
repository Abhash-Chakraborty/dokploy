import { eq } from "drizzle-orm";
import { db } from "../../../db";
import { mariadb, mysql, postgres } from "../../../db/schema";
import { runWhereDataIs } from "../backups/service";

export type SqlEngine = "postgres" | "mysql" | "mariadb";

const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;

/** Identifiers cannot be parameterised, so they are strictly validated. */
export const assertIdentifier = (value: string) => {
	if (!/^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/.test(value)) {
		throw new Error(
			`"${value}" is not a valid name: letters, digits, underscores and hyphens, starting with a letter`,
		);
	}
	return value;
};

const containerOf = (appName: string) =>
	`$(docker ps --filter "label=com.docker.swarm.service.name=${appName}" --filter "status=running" -q | head -1)`;

type Service = {
	appName: string;
	serverId: string | null;
	username: string;
	database: string;
};

export const findSqlService = async (
	engine: SqlEngine,
	serviceId: string,
): Promise<Service> => {
	if (engine === "postgres") {
		const row = await db.query.postgres.findFirst({
			where: eq(postgres.postgresId, serviceId),
		});
		if (!row) throw new Error("Service not found");
		return {
			appName: row.appName,
			serverId: row.serverId,
			username: row.databaseUser,
			database: row.databaseName,
		};
	}
	const row =
		engine === "mysql"
			? await db.query.mysql.findFirst({ where: eq(mysql.mysqlId, serviceId) })
			: await db.query.mariadb.findFirst({
					where: eq(mariadb.mariadbId, serviceId),
				});
	if (!row) throw new Error("Service not found");
	return {
		appName: row.appName,
		serverId: row.serverId,
		username: "root",
		database: row.databaseName,
	};
};

const psql = (service: Service, sql: string) =>
	`docker exec ${containerOf(service.appName)} psql -U ${quote(service.username)} -d ${quote(service.database)} -tAc ${quote(sql)}`;

const mysqlClient = (engine: SqlEngine, service: Service, sql: string) => {
	const client = engine === "mysql" ? "mysql" : "mariadb";
	return `docker exec ${containerOf(service.appName)} sh -c ${quote(
		`exec ${client} -uroot -p"$MYSQL_ROOT_PASSWORD" -N -B -e ${quote(sql)}`,
	)}`;
};

const run = async (engine: SqlEngine, service: Service, sql: string) => {
	const command =
		engine === "postgres"
			? psql(service, sql)
			: mysqlClient(engine, service, sql);
	const result = await runWhereDataIs(service.serverId, command, {
		timeoutMs: 60_000,
	});
	if (result.exitCode !== 0) {
		throw new Error((result.stderr || result.stdout).slice(-400));
	}
	return result.stdout.trim();
};

const rows = (output: string) =>
	output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);

export const listDatabases = async (engine: SqlEngine, serviceId: string) => {
	const service = await findSqlService(engine, serviceId);
	const sql =
		engine === "postgres"
			? "select datname from pg_database where datistemplate = false order by 1"
			: "show databases";
	return rows(await run(engine, service, sql));
};

export const listUsers = async (engine: SqlEngine, serviceId: string) => {
	const service = await findSqlService(engine, serviceId);
	const sql =
		engine === "postgres"
			? "select rolname from pg_roles where rolcanlogin order by 1"
			: "select distinct user from mysql.user order by 1";
	return rows(await run(engine, service, sql));
};

export const createDatabase = async (
	engine: SqlEngine,
	serviceId: string,
	name: string,
) => {
	const service = await findSqlService(engine, serviceId);
	assertIdentifier(name);
	await run(
		engine,
		service,
		engine === "postgres"
			? `create database "${name}"`
			: `create database \`${name}\``,
	);
	return true;
};

export const createUser = async (
	engine: SqlEngine,
	serviceId: string,
	input: {
		username: string;
		password: string;
		database?: string;
		readOnly?: boolean;
	},
) => {
	const service = await findSqlService(engine, serviceId);
	assertIdentifier(input.username);
	if (input.database) assertIdentifier(input.database);
	const password = input.password.replace(/'/g, "''");
	if (engine === "postgres") {
		await run(
			engine,
			service,
			`create role "${input.username}" login password '${password}'`,
		);
		if (input.database) {
			await run(
				engine,
				service,
				input.readOnly
					? `grant connect on database "${input.database}" to "${input.username}"`
					: `grant all privileges on database "${input.database}" to "${input.username}"`,
			);
		}
		if (input.readOnly) {
			await run(
				engine,
				service,
				`grant usage on schema public to "${input.username}"; grant select on all tables in schema public to "${input.username}"; alter default privileges in schema public grant select on tables to "${input.username}"`,
			);
		}
		return true;
	}
	await run(
		engine,
		service,
		`create user '${input.username}'@'%' identified by '${password}'`,
	);
	const scope = input.database ? `\`${input.database}\`.*` : "*.*";
	await run(
		engine,
		service,
		`grant ${input.readOnly ? "select" : "all privileges"} on ${scope} to '${input.username}'@'%'; flush privileges`,
	);
	return true;
};

export const dropUser = async (
	engine: SqlEngine,
	serviceId: string,
	username: string,
) => {
	const service = await findSqlService(engine, serviceId);
	assertIdentifier(username);
	await run(
		engine,
		service,
		engine === "postgres"
			? `drop role "${username}"`
			: `drop user '${username}'@'%'`,
	);
	return true;
};

export const listExtensions = async (serviceId: string) => {
	const service = await findSqlService("postgres", serviceId);
	const installed = rows(
		await run(
			"postgres",
			service,
			"select extname from pg_extension order by 1",
		),
	);
	const available = rows(
		await run(
			"postgres",
			service,
			"select name from pg_available_extensions order by 1",
		),
	);
	return { installed, available };
};

export const enableExtension = async (serviceId: string, name: string) => {
	const service = await findSqlService("postgres", serviceId);
	assertIdentifier(name);
	await run("postgres", service, `create extension if not exists "${name}"`);
	return true;
};
