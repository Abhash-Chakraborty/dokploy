// Fails when code outside a /proprietary directory imports from one.
//
// Content under /proprietary is covered by Dokploy's LICENSE_PROPRIETARY.md.
// This fork implements those features itself under `abhash` paths and keeps
// /proprietary out of its build and image (see tsconfig excludes and
// .dockerignore); an import from it would pull that code back in.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync(
	"git",
	["ls-files", "--", "*.ts", "*.tsx", "*.mjs", "*.js"],
	{ encoding: "utf8" },
)
	.split("\n")
	.filter((file) => file && !file.includes("/proprietary/"));

const pattern =
	/(?:from\s+|import\s*\(\s*|require\s*\(\s*|vi\.mock\s*\(\s*)["'][^"']*\/proprietary(?:\/|["'])/;

const offenders = [];
for (const file of files) {
	const lines = readFileSync(file, "utf8").split("\n");
	lines.forEach((line, index) => {
		if (pattern.test(line))
			offenders.push(`${file}:${index + 1}: ${line.trim()}`);
	});
}

if (offenders.length > 0) {
	console.error("Imports from /proprietary are not allowed in this fork:\n");
	console.error(offenders.join("\n"));
	process.exit(1);
}
console.log(`No /proprietary imports in ${files.length} files.`);
