import { PenLine, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { DialogAction } from "@/components/shared/dialog-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/utils/api";

type Permissions = Record<string, string[]>;

// Presentation only: groups the access-control resources the way the
// dashboard is organised. Resources not listed here land in "Other".
const GROUPS: { title: string; resources: string[] }[] = [
	{
		title: "Projects & services",
		resources: [
			"project",
			"environment",
			"service",
			"deployment",
			"domain",
			"volume",
			"logs",
			"monitoring",
		],
	},
	{
		title: "Secrets & configuration",
		resources: [
			"envVars",
			"projectEnvVars",
			"environmentEnvVars",
			"vaultProvider",
			"tag",
		],
	},
	{
		title: "Data",
		resources: ["backup", "volumeBackup", "schedule", "destination"],
	},
	{
		title: "Infrastructure",
		resources: [
			"server",
			"docker",
			"traefikFiles",
			"registry",
			"certificate",
			"dnsProvider",
			"sshKeys",
			"gitProviders",
		],
	},
	{
		title: "Organization",
		resources: ["member", "invitation", "notification", "auditLog", "api"],
	},
];

const LABELS: Record<string, string> = {
	envVars: "Service env vars",
	projectEnvVars: "Project env vars",
	environmentEnvVars: "Environment env vars",
	volumeBackup: "Volume backups",
	traefikFiles: "Traefik files",
	sshKeys: "SSH keys",
	gitProviders: "Git providers",
	dnsProvider: "DNS providers",
	vaultProvider: "Secret vaults",
	auditLog: "Audit log",
	api: "API",
};

const label = (resource: string) =>
	LABELS[resource] ??
	resource.charAt(0).toUpperCase() +
		resource.slice(1).replace(/([A-Z])/g, " $1");

const summarize = (permissions: Permissions) => {
	const count = Object.values(permissions).reduce((n, a) => n + a.length, 0);
	return `${count} permission${count === 1 ? "" : "s"} across ${Object.keys(permissions).length} resource${Object.keys(permissions).length === 1 ? "" : "s"}`;
};

const RoleDialog = ({
	initial,
	children,
}: {
	initial?: { role: string; permissions: Permissions };
	children: React.ReactNode;
}) => {
	const utils = api.useUtils();
	const [open, setOpen] = useState(false);
	const [name, setName] = useState(initial?.role ?? "");
	const [permissions, setPermissions] = useState<Permissions>(
		initial?.permissions ?? {},
	);
	const { data } = api.customRole.getStatements.useQuery(undefined, {
		enabled: open,
	});
	const create = api.customRole.create.useMutation();
	const update = api.customRole.update.useMutation();

	useEffect(() => {
		if (open) {
			setName(initial?.role ?? "");
			setPermissions(initial?.permissions ?? {});
		}
	}, [open, initial]);

	const statements = (data?.statements ?? {}) as Record<
		string,
		readonly string[]
	>;
	const groups = useMemo(() => {
		const known = new Set(GROUPS.flatMap((g) => g.resources));
		const other = Object.keys(statements).filter((r) => !known.has(r));
		return [
			...GROUPS.map((g) => ({
				...g,
				resources: g.resources.filter((r) => r in statements),
			})),
			{ title: "Other", resources: other },
		].filter((g) => g.resources.length > 0);
	}, [statements]);

	const toggle = (resource: string, action: string, on: boolean) =>
		setPermissions((prev) => {
			const current = new Set(prev[resource] ?? []);
			if (on) current.add(action);
			else current.delete(action);
			return { ...prev, [resource]: [...current] };
		});

	const toggleAll = (resource: string, on: boolean) =>
		setPermissions((prev) => ({
			...prev,
			[resource]: on ? [...(statements[resource] ?? [])] : [],
		}));

	const save = async () => {
		const request = initial
			? update.mutateAsync({
					roleName: initial.role,
					newRoleName: name !== initial.role ? name : undefined,
					permissions,
				})
			: create.mutateAsync({ roleName: name, permissions });
		await request
			.then(async () => {
				await utils.customRole.invalidate();
				toast.success(initial ? "Role updated" : "Role created");
				setOpen(false);
			})
			.catch((error: Error) => toast.error(error.message));
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>{children}</DialogTrigger>
			<DialogContent className="sm:max-w-3xl max-h-[85vh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>{initial ? "Edit role" : "Create role"}</DialogTitle>
					<DialogDescription>
						A role grants actions on resources. Which projects and services a
						member can reach is set per member.
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-2">
					<Label htmlFor="role-name">Name</Label>
					<Input
						id="role-name"
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="release-manager"
					/>
				</div>
				<div className="flex flex-col gap-6">
					{groups.map((group) => (
						<div key={group.title} className="flex flex-col gap-2">
							<h4 className="text-sm font-medium">{group.title}</h4>
							<div className="divide-y rounded-lg border">
								{group.resources.map((resource) => {
									const actions = statements[resource] ?? [];
									const granted = new Set(permissions[resource] ?? []);
									return (
										<div
											key={resource}
											className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center"
										>
											<div className="flex w-48 shrink-0 items-center gap-2 text-sm">
												<Checkbox
													id={`perm-${resource}`}
													checked={
														granted.size === actions.length
															? true
															: granted.size > 0
																? "indeterminate"
																: false
													}
													onCheckedChange={(on) =>
														toggleAll(resource, on === true)
													}
												/>
												<Label
													htmlFor={`perm-${resource}`}
													className="font-normal"
												>
													{label(resource)}
												</Label>
											</div>
											<div className="flex flex-wrap gap-x-4 gap-y-1">
												{actions.map((action) => (
													<div
														key={action}
														className="flex items-center gap-1.5 text-sm"
													>
														<Checkbox
															id={`perm-${resource}-${action}`}
															checked={granted.has(action)}
															onCheckedChange={(on) =>
																toggle(resource, action, on === true)
															}
														/>
														<Label
															htmlFor={`perm-${resource}-${action}`}
															className="font-normal text-muted-foreground"
														>
															{action}
														</Label>
													</div>
												))}
											</div>
										</div>
									);
								})}
							</div>
						</div>
					))}
				</div>
				<DialogFooter>
					<Button
						onClick={save}
						disabled={!name.trim()}
						isLoading={create.isPending || update.isPending}
					>
						{initial ? "Save role" : "Create role"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};

export const ManageCustomRoles = () => {
	const utils = api.useUtils();
	const { data: roles, isLoading } = api.customRole.all.useQuery();
	const remove = api.customRole.remove.useMutation();

	return (
		<section className="flex flex-col gap-3">
			<div className="flex flex-wrap items-end justify-between gap-2">
				<div>
					<h2 className="flex items-center gap-2 text-xl font-medium">
						<ShieldCheck className="size-5 text-muted-foreground" />
						Custom roles
					</h2>
					<p className="text-sm text-muted-foreground">
						Roles beyond Owner, Admin and Member, with exactly the permissions
						you choose.
					</p>
				</div>
				<RoleDialog>
					<Button>
						<Plus className="size-4" />
						Create role
					</Button>
				</RoleDialog>
			</div>

			{isLoading ? (
				<p className="text-sm text-muted-foreground">Loading roles…</p>
			) : !roles?.length ? (
				<div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-10 text-center">
					<ShieldCheck className="size-8 text-muted-foreground" />
					<p className="text-sm text-muted-foreground">No custom roles yet.</p>
				</div>
			) : (
				<div className="divide-y rounded-lg border">
					{roles.map((role) => (
						<div
							key={role.role}
							className="flex items-center justify-between gap-4 px-4 py-3"
						>
							<div className="min-w-0">
								<div className="flex items-center gap-2">
									<span className="truncate font-medium">{role.role}</span>
									<Badge variant="secondary">
										{role.memberCount} member{role.memberCount === 1 ? "" : "s"}
									</Badge>
								</div>
								<p className="text-sm text-muted-foreground">
									{summarize(role.permissions)}
								</p>
							</div>
							<div className="flex shrink-0 items-center gap-1">
								<RoleDialog initial={role}>
									<Button variant="ghost" size="icon" aria-label="Edit role">
										<PenLine className="size-4" />
									</Button>
								</RoleDialog>
								<DialogAction
									title={`Delete ${role.role}?`}
									description="Members must be moved to another role first."
									type="destructive"
									onClick={async () => {
										await remove
											.mutateAsync({ roleName: role.role })
											.then(async () => {
												await utils.customRole.invalidate();
												toast.success("Role deleted");
											})
											.catch((error: Error) => toast.error(error.message));
									}}
								>
									<Button
										variant="ghost"
										size="icon"
										aria-label="Delete role"
										className="text-destructive hover:text-destructive"
									>
										<Trash2 className="size-4" />
									</Button>
								</DialogAction>
							</div>
						</div>
					))}
				</div>
			)}
		</section>
	);
};
