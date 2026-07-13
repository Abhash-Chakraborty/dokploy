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

// The original upstream Dokploy license (LICENSE.MD) shown at the bottom for
// reference. Keep in sync with that file.
const ORIGINAL_LICENSE_MD = `Copyright 2026-present Dokploy Technology, Inc.

Portions of this software are licensed as follows:

- All content that resides under a "/proprietary" directory of this repository, if that directory exists, is licensed under the license defined in "LICENSE_PROPRIETARY".
- Content outside of the above mentioned directories or restrictions above is available under the "Apache License 2.0" license as defined below.

## Apache License 2.0

Copyright 2026-present Dokploy Technology, Inc.

Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
`;

export function AbhashLicenseSettings() {
	return (
		<div className="space-y-6">
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

			<div className="space-y-4 border-t pt-6">
				<div className="flex flex-wrap items-center gap-2">
					<h2 className="text-lg font-semibold tracking-tight text-muted-foreground">
						Original Dokploy License
					</h2>
					<Badge variant="secondary">Upstream</Badge>
				</div>
				<article className="prose prose-sm dark:prose-invert max-w-none prose-headings:tracking-tight prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:before:content-none prose-code:after:content-none">
					<Markdown>{ORIGINAL_LICENSE_MD}</Markdown>
				</article>
			</div>
		</div>
	);
}
