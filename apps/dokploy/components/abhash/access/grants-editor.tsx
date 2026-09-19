import {
	Boxes,
	FolderKanban,
	GitBranch,
	Globe,
	Layers,
	Plus,
	Server,
	Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api, type RouterOutputs } from "@/utils/api";

type Scopes = RouterOutputs["access"]["scopes"];
type ScopeType =
	| "organization"
	| "project"
	| "environment"
	| "service"
	| "server"
	| "gitProvider";

export const SCOPE_META: Record<
	ScopeType,
	{ label: string; icon: typeof Globe }
> = {
	organization: { label: "All projects", icon: Globe },
	project: { label: "Project", icon: FolderKanban },
	environment: { label: "Environment", icon: Layers },
	service: { label: "Service", icon: Boxes },
	server: { label: "Server", icon: Server },
	gitProvider: { label: "Git provider", icon: GitBranch },
};

/** Human-readable name for a scope, from the scope tree. */
export const useScopeNames = (scopes: Scopes | undefined) =>
	useMemo(() => {
		const names = new Map<string, string>();
		for (const p of scopes?.projects ?? []) {
			names.set(`project:${p.id}`, p.name);
			for (const e of p.environments) {
				names.set(`environment:${e.id}`, `${p.name} / ${e.name}`);
				for (const s of e.services) {
					names.set(`service:${s.id}`, `${p.name} / ${e.name} / ${s.name}`);
				}
			}
		}
		for (const s of scopes?.servers ?? []) names.set(`server:${s.id}`, s.name);
		for (const g of scopes?.gitProviders ?? []) {
			names.set(`gitProvider:${g.id}`, g.name);
		}
		return (type: ScopeType, id: string) =>
			type === "organization"
				? "Every project, now and future"
				: (names.get(`${type}:${id}`) ?? "Deleted resource");
	}, [scopes]);

const scopeOptions = (scopes: Scopes | undefined, type: ScopeType) => {
	if (!scopes) return [];
	switch (type) {
		case "project":
			return scopes.projects.map((p) => ({
				id: p.id,
				name: p.name,
				group: "",
			}));
		case "environment":
			return scopes.projects.flatMap((p) =>
				p.environments.map((e) => ({ id: e.id, name: e.name, group: p.name })),
			);
		case "service":
			return scopes.projects.flatMap((p) =>
				p.environments.flatMap((e) =>
					e.services.map((s) => ({
						id: s.id,
						name: `${s.name} (${s.type})`,
						group: `${p.name} / ${e.name}`,
					})),
				),
			);
		case "server":
			return scopes.servers.map((s) => ({ id: s.id, name: s.name, group: "" }));
		case "gitProvider":
			return scopes.gitProviders.map((g) => ({
				id: g.id,
				name: `${g.name} (${g.type})`,
				group: "",
			}));
		default:
			return [];
	}
};

type Props = {
	subjectType: "user" | "team";
	subjectId: string;
	canEdit: boolean;
};

export const GrantsEditor = ({ subjectType, subjectId, canEdit }: Props) => {
	const utils = api.useUtils();
	const { data: grants, isLoading } = api.access.bindings.list.useQuery({
		subjectType,
		subjectId,
	});
	const { data: scopes } = api.access.scopes.useQuery(undefined, {
		enabled: canEdit,
	});
	const { data: roles } = api.access.roles.useQuery();
	const create = api.access.bindings.create.useMutation();
	const remove = api.access.bindings.remove.useMutation();
	const scopeName = useScopeNames(scopes);

	const [scopeType, setScopeType] = useState<ScopeType>("project");
	const [scopeId, setScopeId] = useState("");
	const [role, setRole] = useState("viewer");
	const [inherit, setInherit] = useState(true);

	const options = scopeOptions(scopes, scopeType);
	const groups = [...new Set(options.map((o) => o.group))];
	const needsId = scopeType !== "organization";
	const canInherit = scopeType === "project" || scopeType === "environment";
	const roleLabel = (key: string) =>
		key === "@org"
			? "Organization role"
			: (roles?.find((r) => r.role === key)?.label ?? key);

	const add = async () => {
		await create
			.mutateAsync({
				subjectType,
				subjectId,
				role,
				scopeType,
				scopeId: needsId ? scopeId : "",
				inherit: scopeType === "organization" ? true : canInherit && inherit,
			})
			.then(async () => {
				await utils.access.bindings.invalidate();
				setScopeId("");
				toast.success("Access granted");
			})
			.catch((error: Error) => toast.error(error.message));
	};

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-col gap-2">
				<h4 className="text-sm font-medium">
					{subjectType === "team" ? "Team access" : "Direct access"}
				</h4>
				{isLoading ? (
					<p className="text-sm text-muted-foreground">Loading…</p>
				) : !grants?.length ? (
					<p className="rounded-md border border-dashed px-3 py-4 text-center text-sm text-muted-foreground">
						No access granted yet.
					</p>
				) : (
					<ul className="divide-y rounded-md border">
						{grants.map((g) => {
							const Icon = SCOPE_META[g.scopeType].icon;
							return (
								<li key={g.id} className="flex items-center gap-3 px-3 py-2">
									<Icon className="size-4 shrink-0 text-muted-foreground" />
									<div className="min-w-0 flex-1">
										<p className="truncate text-sm">
											{scopeName(g.scopeType, g.scopeId)}
										</p>
										<p className="text-xs text-muted-foreground">
											{SCOPE_META[g.scopeType].label}
											{!g.inherit && g.scopeType !== "service"
												? " · this item only"
												: ""}
											{g.source !== "manual" ? ` · from ${g.source}` : ""}
										</p>
									</div>
									<Badge variant="secondary">{roleLabel(g.role)}</Badge>
									{canEdit && g.source === "manual" && (
										<Button
											variant="ghost"
											size="icon"
											aria-label="Remove access"
											onClick={async () => {
												await remove
													.mutateAsync({ bindingId: g.id })
													.then(() => utils.access.bindings.invalidate())
													.catch((error: Error) => toast.error(error.message));
											}}
										>
											<Trash2 className="size-4" />
										</Button>
									)}
								</li>
							);
						})}
					</ul>
				)}
			</div>

			{canEdit && (
				<div className="flex flex-col gap-3 rounded-md border bg-muted/30 p-3">
					<h4 className="text-sm font-medium">Grant access</h4>
					<div className="grid gap-3 sm:grid-cols-2">
						<div className="flex flex-col gap-1.5">
							<Label>Scope</Label>
							<Select
								value={scopeType}
								onValueChange={(v) => {
									setScopeType(v as ScopeType);
									setScopeId("");
								}}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{(Object.keys(SCOPE_META) as ScopeType[]).map((type) => (
										<SelectItem key={type} value={type}>
											{SCOPE_META[type].label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label>Role</Label>
							<Select value={role} onValueChange={setRole}>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{roles?.map((r) => (
										<SelectItem key={r.role} value={r.role}>
											{r.label}
											{!r.builtin && " (custom)"}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</div>
					{needsId && (
						<div className="flex flex-col gap-1.5">
							<Label>{SCOPE_META[scopeType].label}</Label>
							<Select value={scopeId} onValueChange={setScopeId}>
								<SelectTrigger>
									<SelectValue
										placeholder={
											options.length
												? `Choose a ${SCOPE_META[scopeType].label.toLowerCase()}`
												: "Nothing to choose"
										}
									/>
								</SelectTrigger>
								<SelectContent>
									{groups.map((group) => (
										<SelectGroup key={group || "all"}>
											{group && <SelectLabel>{group}</SelectLabel>}
											{options
												.filter((o) => o.group === group)
												.map((o) => (
													<SelectItem key={o.id} value={o.id}>
														{o.name}
													</SelectItem>
												))}
										</SelectGroup>
									))}
								</SelectContent>
							</Select>
						</div>
					)}
					{canInherit && (
						<div className="flex items-center justify-between gap-3">
							<div>
								<Label htmlFor={`inherit-${subjectId}`}>
									Include everything inside
								</Label>
								<p className="text-xs text-muted-foreground">
									Also applies to its{" "}
									{scopeType === "project"
										? "environments and services"
										: "services"}
									, including ones created later.
								</p>
							</div>
							<Switch
								id={`inherit-${subjectId}`}
								checked={inherit}
								onCheckedChange={setInherit}
							/>
						</div>
					)}
					<div className="flex justify-end">
						<Button
							onClick={add}
							isLoading={create.isPending}
							disabled={needsId && !scopeId}
						>
							<Plus className="size-4" />
							Grant
						</Button>
					</div>
				</div>
			)}
		</div>
	);
};
