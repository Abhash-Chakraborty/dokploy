#!/usr/bin/env node
// Drops packages the production server never loads from the deployed
// node_modules. pnpm installs them anyway: build-only compiler binaries,
// musl builds on a glibc image, and optional peers of better-auth and
// drizzle (Prisma, SQLite, PGlite) that this app does not use. Together they
// were about a fifth of the image.
//
// usage: prune-runtime-deps.mjs <app-dir>
import fs from "node:fs";
import path from "node:path";

const appDir = process.argv[2];
if (!appDir) {
	console.error("usage: prune-runtime-deps.mjs <app-dir>");
	process.exit(2);
}

// Matched against directory names in node_modules/.pnpm.
const DROP = [
	/^@next\+swc-/,
	/-musl[@-]/,
	/^@img\+sharp-libvips-linuxmusl/,
	/^@img\+sharp-linuxmusl/,
	/^@typescript\+typescript-/,
	/^typescript@/,
	/^prisma@/,
	/^@prisma\+/,
	/^@better-auth\+prisma-adapter@/,
	/^better-sqlite3@/,
	/^@electric-sql\+pglite@/,
];

const storeDir = path.join(appDir, "node_modules", ".pnpm");
let freed = 0;
const sizeOf = (dir) => {
	let total = 0;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) total += sizeOf(full);
		else if (entry.isFile()) total += fs.statSync(full).size;
	}
	return total;
};
const dropped = [];
for (const name of fs.readdirSync(storeDir)) {
	if (!DROP.some((pattern) => pattern.test(name))) continue;
	const full = path.join(storeDir, name);
	freed += sizeOf(full);
	fs.rmSync(full, { recursive: true, force: true });
	dropped.push(name);
}

// Anything the built server reaches through a Turbopack external link must
// still resolve, or the image would only fail at startup.
const linksDir = path.join(appDir, ".next", "node_modules");
const broken = [];
const walk = (dir) => {
	if (!fs.existsSync(dir)) return;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isSymbolicLink()) {
			const target = fs.readlinkSync(full);
			const local = target.startsWith("/app/")
				? path.join(appDir, target.slice("/app/".length))
				: path.resolve(path.dirname(full), target);
			if (!fs.existsSync(local)) broken.push(`${entry.name} -> ${target}`);
		} else if (entry.isDirectory() && entry.name.startsWith("@")) walk(full);
	}
};
walk(linksDir);
if (broken.length) {
	console.error(
		`Pruning removed packages the server links to:\n${broken.join("\n")}`,
	);
	process.exit(1);
}

console.log(
	`Pruned ${dropped.length} packages, ${(freed / 1024 / 1024).toFixed(0)} MB:\n  ${dropped.join("\n  ")}`,
);
