import { Badge } from "@/components/ui/badge";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";

export function AbhashLicenseSettings() {
	return (
		<div className="space-y-4">
			<CardHeader className="px-0 pt-0">
				<div className="flex flex-wrap items-center gap-2">
					<CardTitle className="text-xl">Abhash Personal License</CardTitle>
					<Badge variant="green">Active</Badge>
				</div>
				<CardDescription>
					This fork keeps Abhash-owned additions separate from Dokploy's
					proprietary folders and unlocks personal self-hosted usage without a
					commercial license server.
				</CardDescription>
			</CardHeader>

			<Card>
				<CardHeader>
					<CardTitle className="text-base">License Scope</CardTitle>
					<CardDescription>
						The personal features in `components/abhash`,
						`server/api/routers/abhash`, and `services/abhash` are maintained
						for Abhash's own deployment.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-3 text-sm text-muted-foreground">
					<p>
						You may use, modify, run, and back up these Abhash-owned changes for
						your personal infrastructure.
					</p>
					<p>
						You should not sell, sublicense, or publish these personal additions
						as a commercial Dokploy replacement without a separate explicit
						license from Abhash.
					</p>
					<p>
						Upstream Dokploy files keep their original licenses. This page does
						not relicense Dokploy proprietary code or remove any third-party
						obligations.
					</p>
				</CardContent>
			</Card>
		</div>
	);
}
