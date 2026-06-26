import Markdown from "react-markdown";
import { Badge } from "@/components/ui/badge";

// The personal license text (LICENSE_ABHASH_PERSONAL.md) rendered inline so it
// ships with the bundle without a server read. Keep in sync with that file.
const LICENSE_MD = `# Abhash Personal Additions License

Copyright (c) Abhash Chakraborty.

This license applies only to source files intentionally placed under Abhash-owned paths such as:

- \`apps/dokploy/components/abhash\`
- \`apps/dokploy/server/api/routers/abhash\`
- \`packages/server/src/services/abhash\`

Abhash Chakraborty may use, modify, run, copy, and archive these additions for personal self-hosted deployments.

No permission is granted to sell, sublicense, repackage, host as a paid service, or distribute these Abhash-owned additions as a commercial Dokploy replacement without separate written permission from Abhash Chakraborty.

This license does not relicense upstream Dokploy source code, Dokploy proprietary source-available files, Apache-2.0 files, dependency code, or any third-party material. Those files remain under their own licenses.
`;

export function AbhashLicenseSettings() {
	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-center gap-2">
				<h2 className="text-xl font-semibold tracking-tight">
					Abhash Personal License
				</h2>
				<Badge variant="green">Active</Badge>
			</div>

			<article className="prose prose-sm dark:prose-invert max-w-none prose-headings:tracking-tight prose-h1:text-2xl prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:before:content-none prose-code:after:content-none">
				<Markdown>{LICENSE_MD}</Markdown>
			</article>
		</div>
	);
}
