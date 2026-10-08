#!/usr/bin/env node
// Turbopack keeps server dependencies outside its bundle and reaches them
// through symlinks in .next/node_modules that point into the monorepo's
// pnpm store (../../../../node_modules/.pnpm/...). The image ships a
// `pnpm deploy` copy of the app instead, so those links would dangle and the
// server fails at startup with "Cannot find module 'bcrypt-<hash>'".
//
// usage: relink-next-externals.mjs <app-dir> [runtime-app-dir]
//   app-dir          the deployed app holding .next and node_modules
//   runtime-app-dir  where that directory lives in the final image (/app)
import fs from "node:fs";
import path from "node:path";

const [appDir, runtimeDir = appDir] = process.argv.slice(2);
if (!appDir) {
	console.error("usage: relink-next-externals.mjs <app-dir> [runtime-app-dir]");
	process.exit(2);
}

const linksDir = path.join(appDir, ".next", "node_modules");
const storeDir = path.join(appDir, "node_modules", ".pnpm");

const links = [];
const walk = (dir) => {
	if (!fs.existsSync(dir)) return;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isSymbolicLink()) links.push(full);
		else if (entry.isDirectory() && entry.name.startsWith("@")) walk(full);
	}
};
walk(linksDir);

const broken = [];
for (const link of links) {
	const target = fs.readlinkSync(link);
	const marker = "node_modules/.pnpm/";
	const storeRelative = target.includes(marker)
		? target.slice(target.indexOf(marker) + marker.length)
		: null;
	const pkg = target.slice(target.lastIndexOf("node_modules/") + 13);
	const candidates = [
		storeRelative && path.join("node_modules", ".pnpm", storeRelative),
		path.join("node_modules", pkg),
	].filter(Boolean);
	const found = candidates.find((rel) => fs.existsSync(path.join(appDir, rel)));
	if (!found) {
		broken.push(`${path.relative(linksDir, link)} -> ${target}`);
		continue;
	}
	fs.rmSync(link);
	fs.symlinkSync(path.join(runtimeDir, found), link);
}

if (broken.length) {
	console.error(`Unresolvable Turbopack externals:\n${broken.join("\n")}`);
	process.exit(1);
}
console.log(
	`Relinked ${links.length} Turbopack externals into ${path.join(runtimeDir, "node_modules")} (store: ${fs.existsSync(storeDir)})`,
);
