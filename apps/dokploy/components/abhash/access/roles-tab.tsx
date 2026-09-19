import { ManageCustomRoles } from "@/components/abhash/roles/manage-custom-roles";
import { Badge } from "@/components/ui/badge";

const ORG_ROLES = [
	{
		name: "Owner",
		summary:
			"Everything, including deleting the organization. One per organization.",
	},
	{
		name: "Admin",
		summary:
			"Everything except deleting the organization. Reaches every project.",
	},
	{
		name: "Member",
		summary:
			"Reaches only what it is granted, per project, environment or service.",
	},
];

const SCOPE_ROLES = [
	{
		name: "Viewer",
		summary:
			"Read services, deployments, logs, domains and backups. No environment variables, no changes.",
	},
	{
		name: "Developer",
		summary:
			"Deploy, edit environment variables, domains, volumes, backups and schedules; create environments and services. Cannot delete the project or open host terminals.",
	},
	{
		name: "Project admin",
		summary: "Full control of what is in scope, including deleting it.",
	},
];

export const RolesTab = ({ canEdit }: { canEdit: boolean }) => (
	<div className="flex flex-col gap-8">
		<div className="grid gap-6 lg:grid-cols-2">
			<section className="flex flex-col gap-2">
				<h3 className="text-sm font-medium">Organization roles</h3>
				<p className="text-sm text-muted-foreground">
					One per member. Decides organization-wide powers: servers, registries,
					members, settings.
				</p>
				<ul className="divide-y rounded-lg border">
					{ORG_ROLES.map((r) => (
						<li key={r.name} className="flex flex-col gap-1 px-4 py-3">
							<Badge variant="secondary" className="w-fit">
								{r.name}
							</Badge>
							<p className="text-sm text-muted-foreground">{r.summary}</p>
						</li>
					))}
				</ul>
			</section>
			<section className="flex flex-col gap-2">
				<h3 className="text-sm font-medium">Project roles</h3>
				<p className="text-sm text-muted-foreground">
					Granted to a member or team on all projects, a project, an environment
					or a service.
				</p>
				<ul className="divide-y rounded-lg border">
					{SCOPE_ROLES.map((r) => (
						<li key={r.name} className="flex flex-col gap-1 px-4 py-3">
							<Badge variant="outline" className="w-fit">
								{r.name}
							</Badge>
							<p className="text-sm text-muted-foreground">{r.summary}</p>
						</li>
					))}
				</ul>
			</section>
		</div>
		{canEdit && <ManageCustomRoles />}
	</div>
);
