export type EngineCategory =
	| "sql"
	| "key-value"
	| "analytics"
	| "search"
	| "queue"
	| "storage"
	| "document";

export type EngineField = {
	name: string;
	label: string;
	type: "string" | "number" | "boolean" | "select";
	default?: string | number | boolean;
	options?: string[];
	help?: string;
};

export type EngineConfig = Record<string, string | number | boolean>;

export type RenderedEngine = {
	/** A complete compose file, deployed through the existing pipeline. */
	compose: string;
	/** Written to the stack's .env, so no secret sits in the compose file. */
	env: Record<string, string>;
	/** Shown on the service page; the values come from the .env. */
	connection: { label: string; value: string }[];
	/** Ports the service listens on inside the stack. */
	ports: number[];
};

export type EngineDefinition = {
	id: string;
	label: string;
	category: EngineCategory;
	description: string;
	versions: string[];
	fields: EngineField[];
	/** Everything a drill and a backup need to know about this engine. */
	backup?: { kind: "volume" | "command"; note: string };
	render: (input: {
		name: string;
		version: string;
		config: EngineConfig;
		password: string;
	}) => RenderedEngine;
};

export const num = (config: EngineConfig, key: string, fallback: number) => {
	const value = Number(config[key]);
	return Number.isFinite(value) && value > 0 ? value : fallback;
};

export const bool = (config: EngineConfig, key: string, fallback = false) =>
	typeof config[key] === "boolean" ? (config[key] as boolean) : fallback;

export const text = (config: EngineConfig, key: string, fallback: string) =>
	typeof config[key] === "string" && config[key]
		? String(config[key])
		: fallback;
