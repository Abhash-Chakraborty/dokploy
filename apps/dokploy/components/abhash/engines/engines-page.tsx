import { Boxes, Copy, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { DialogAction } from "@/components/shared/dialog-action";
import { InfoTooltip } from "@/components/shared/info-tooltip";
import { PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api, type RouterOutputs } from "@/utils/api";

type Catalog = RouterOutputs["engines"]["catalog"];
type Engine = Catalog["engines"][number];

const fail = (error: Error) => toast.error(error.message);

const CreateService = ({
	engine,
	onDone,
}: {
	engine: Engine | null;
	onDone: () => void;
}) => {
	const utils = api.useUtils();
	const [name, setName] = useState("");
	const [version, setVersion] = useState(engine?.versions[0] ?? "");
	const [environmentId, setEnvironmentId] = useState("");
	const [config, setConfig] = useState<Record<string, string>>({});
	const { data: projects } = api.project.all.useQuery(undefined, {
		enabled: !!engine,
	});
	const create = api.engines.create.useMutation();
	const deploy = api.compose.deploy.useMutation();
	if (!engine) return null;

	return (
		<Dialog open onOpenChange={(open) => !open && onDone()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>New {engine.label}</DialogTitle>
					<DialogDescription>
						{engine.useFor} It becomes a compose stack in the environment you
						pick, reachable by other services there
						{name ? (
							<>
								{" "}
								at <code>{name}-…</code> on the Dokploy network
							</>
						) : null}
						.
					</DialogDescription>
				</DialogHeader>
				<div className="grid gap-3 sm:grid-cols-2">
					<div className="flex flex-col gap-1.5">
						<Label>Name</Label>
						<Input
							value={name}
							placeholder="cache"
							onChange={(event) => setName(event.target.value.toLowerCase())}
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label>Version</Label>
						<Select value={version} onValueChange={setVersion}>
							<SelectTrigger>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{engine.versions.map((option) => (
									<SelectItem key={option} value={option}>
										{option}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<div className="col-span-full flex flex-col gap-1.5">
						<Label>Environment</Label>
						<Select value={environmentId} onValueChange={setEnvironmentId}>
							<SelectTrigger>
								<SelectValue placeholder="Choose a project environment" />
							</SelectTrigger>
							<SelectContent>
								{projects?.flatMap((project) =>
									(project.environments ?? []).map((environment) => (
										<SelectItem
											key={environment.environmentId}
											value={environment.environmentId}
										>
											{project.name} / {environment.name}
										</SelectItem>
									)),
								)}
							</SelectContent>
						</Select>
					</div>
					{engine.fields.map((field) => (
						<div key={field.name} className="flex flex-col gap-1.5">
							<Label>{field.label}</Label>
							{field.type === "select" ? (
								<Select
									value={config[field.name] ?? String(field.default ?? "")}
									onValueChange={(value) =>
										setConfig({ ...config, [field.name]: value })
									}
								>
									<SelectTrigger>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{(field.options ?? []).map((option) => (
											<SelectItem key={option} value={option}>
												{option}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							) : (
								<Input
									value={config[field.name] ?? String(field.default ?? "")}
									inputMode={field.type === "number" ? "numeric" : undefined}
									onChange={(event) =>
										setConfig({ ...config, [field.name]: event.target.value })
									}
								/>
							)}
						</div>
					))}
				</div>
				<DialogFooter>
					<Button
						isLoading={create.isPending || deploy.isPending}
						disabled={!name || !environmentId}
						onClick={async () => {
							await create
								.mutateAsync({
									engineId: engine.id,
									environmentId,
									name,
									version,
									config: Object.fromEntries(
										Object.entries(config).map(([key, value]) => [
											key,
											Number.isFinite(Number(value)) && value !== ""
												? Number(value)
												: value,
										]),
									),
									serverId: null,
								})
								.then(async (result) => {
									toast.success(`${engine.label} created — deploying`);
									await utils.engines.list.invalidate();
									await deploy
										.mutateAsync({ composeId: result.composeId })
										.catch(() =>
											toast.message(
												"Created. Deploy it from the project page when ready.",
											),
										);
									onDone();
								})
								.catch(fail);
						}}
					>
						Create and deploy
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};

const DatabaseTools = () => {
	const [engine, setEngine] = useState<"postgres" | "mysql" | "mariadb">(
		"postgres",
	);
	const [serviceId, setServiceId] = useState("");
	const [username, setUsername] = useState("");
	const [readOnly, setReadOnly] = useState(true);
	const [issued, setIssued] = useState<string | null>(null);
	const { data: projects } = api.project.all.useQuery();
	const { data, refetch } = api.engines.tools.overview.useQuery(
		{ engine, serviceId },
		{ enabled: !!serviceId },
	);
	const createUser = api.engines.tools.createUser.useMutation();
	const dropUser = api.engines.tools.dropUser.useMutation();
	const enableExtension = api.engines.tools.enableExtension.useMutation();

	const services = (projects ?? []).flatMap((project) =>
		(project.environments ?? []).flatMap((environment) =>
			((environment[engine] ?? []) as { name: string }[]).map(
				(service: Record<string, unknown>) => ({
					id: String(service[`${engine}Id`]),
					label: `${project.name} / ${environment.name} / ${service.name}`,
				}),
			),
		),
	);

	return (
		<div className="flex flex-col gap-3 rounded-md border p-4">
			<div>
				<h3 className="text-sm font-medium">Users, databases and extensions</h3>
				<p className="text-xs text-muted-foreground">
					Databases, users and Postgres extensions on services you already run.
				</p>
			</div>
			<div className="grid gap-3 sm:grid-cols-2">
				<div className="flex flex-col gap-1.5">
					<Label>Engine</Label>
					<Select
						value={engine}
						onValueChange={(value) => {
							setEngine(value as "postgres");
							setServiceId("");
						}}
					>
						<SelectTrigger>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="postgres">Postgres</SelectItem>
							<SelectItem value="mysql">MySQL</SelectItem>
							<SelectItem value="mariadb">MariaDB</SelectItem>
						</SelectContent>
					</Select>
				</div>
				<div className="flex flex-col gap-1.5">
					<Label>Service</Label>
					<Select value={serviceId} onValueChange={setServiceId}>
						<SelectTrigger>
							<SelectValue placeholder="Choose one" />
						</SelectTrigger>
						<SelectContent>
							{services.map((service) => (
								<SelectItem key={service.id} value={service.id}>
									{service.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			</div>

			{data && (
				<div className="grid gap-4 sm:grid-cols-3">
					<div>
						<p className="text-xs font-medium">Databases</p>
						<ul className="text-xs text-muted-foreground">
							{data.databases.map((database) => (
								<li key={database}>{database}</li>
							))}
						</ul>
					</div>
					<div>
						<p className="text-xs font-medium">Users</p>
						<ul className="flex flex-col gap-1 text-xs text-muted-foreground">
							{data.users.map((user) => (
								<li key={user} className="flex items-center gap-2">
									{user}
									<Button
										variant="ghost"
										size="sm"
										className="h-5 text-destructive hover:text-destructive"
										onClick={async () => {
											await dropUser
												.mutateAsync({ engine, serviceId, username: user })
												.then(async () => {
													toast.success(`${user} removed`);
													await refetch();
												})
												.catch(fail);
										}}
									>
										drop
									</Button>
								</li>
							))}
						</ul>
					</div>
					{data.extensions && (
						<div>
							<p className="text-xs font-medium">Extensions</p>
							<div className="flex flex-wrap gap-1">
								{data.extensions.installed.map((extension) => (
									<Badge key={extension} variant="green">
										{extension}
									</Badge>
								))}
							</div>
							<div className="mt-2 flex flex-wrap gap-1">
								{data.extensions.available
									.filter(
										(extension) =>
											!data.extensions?.installed.includes(extension),
									)
									.slice(0, 12)
									.map((extension) => (
										<Button
											key={extension}
											variant="outline"
											size="sm"
											className="h-6 text-xs"
											onClick={async () => {
												await enableExtension
													.mutateAsync({ serviceId, name: extension })
													.then(async () => {
														toast.success(`${extension} enabled`);
														await refetch();
													})
													.catch(fail);
											}}
										>
											+ {extension}
										</Button>
									))}
							</div>
						</div>
					)}
				</div>
			)}

			{serviceId && (
				<div className="flex flex-wrap items-end gap-2">
					<div className="flex flex-col gap-1.5">
						<Label>New user</Label>
						<Input
							value={username}
							placeholder="reporting"
							onChange={(event) => setUsername(event.target.value)}
						/>
					</div>
					<div className="flex items-center gap-2 rounded-md border p-2">
						<span className="text-xs">Read-only</span>
						<Switch checked={readOnly} onCheckedChange={setReadOnly} />
					</div>
					<Button
						isLoading={createUser.isPending}
						disabled={!username}
						onClick={async () => {
							await createUser
								.mutateAsync({ engine, serviceId, username, readOnly })
								.then(async (result) => {
									setIssued(result.password);
									setUsername("");
									await refetch();
								})
								.catch(fail);
						}}
					>
						Create user
					</Button>
					{issued && (
						<div className="flex items-center gap-2 rounded-md border px-3 py-2">
							<code className="text-xs">{issued}</code>
							<Button
								variant="ghost"
								size="icon"
								aria-label="Copy password"
								onClick={async () => {
									await navigator.clipboard.writeText(issued);
									toast.success("Copied — it is not shown again");
								}}
							>
								<Copy className="size-4" />
							</Button>
						</div>
					)}
				</div>
			)}
		</div>
	);
};

const CATEGORIES: Record<string, { label: string; hint: string }> = {
	"key-value": {
		label: "Caches and key-value",
		hint: "In-memory stores that speak the Redis protocol.",
	},
	search: {
		label: "Search and vectors",
		hint: "Find things by text or by meaning, faster than a SQL LIKE.",
	},
	queue: {
		label: "Queues and streams",
		hint: "Hand work between services without them waiting on each other.",
	},
	analytics: {
		label: "Analytics",
		hint: "Aggregate over huge tables of events.",
	},
	document: { label: "Documents", hint: "Schemaless JSON documents." },
	storage: { label: "Object storage", hint: "Files over the S3 API." },
	sql: { label: "SQL", hint: "Relational databases." },
};

const statusVariant = (status?: string | null) =>
	status === "done" ? "green" : status === "error" ? "red" : "outline";

export const EnginesPage = () => {
	const utils = api.useUtils();
	const { data: catalog } = api.engines.catalog.useQuery();
	const { data: services } = api.engines.list.useQuery();
	const [chosen, setChosen] = useState<Engine | null>(null);
	const forget = api.engines.forget.useMutation();

	const groups = Object.entries(CATEGORIES)
		.map(([id, meta]) => ({
			id,
			...meta,
			engines:
				catalog?.engines.filter((engine) => engine.category === id) ?? [],
		}))
		.filter((group) => group.engines.length > 0);

	return (
		<section className="flex flex-col gap-6">
			<PageHeader
				icon={<Boxes className="size-5" />}
				title={
					<span className="flex items-center gap-2">
						Databases and services
						<InfoTooltip
							content={
								<span>
									A catalogue, not something already running: nothing here
									exists until you add it. Adding one creates an ordinary
									compose stack in the project you pick and deploys it. Other
									services reach it on the Dokploy network at the address shown
									in its stack; no port is opened to the internet. Postgres,
									MySQL, MariaDB, MongoDB and Redis stay in each project's
									Create menu.
								</span>
							}
						/>
					</span>
				}
				description="Extra engines for caching, search, queues and storage, set up for you."
			/>

			{services && services.length > 0 && (
				<div className="flex flex-col gap-2">
					<h2 className="text-sm font-medium">Added by you</h2>
					<ul className="divide-y rounded-md border">
						{services.map((service) => {
							const env = service.stack?.environment;
							const href =
								env && service.stack
									? `/dashboard/project/${env.projectId}/environment/${service.stack.environmentId}/services/compose/${service.composeId}`
									: null;
							return (
								<li
									key={service.id}
									className="flex items-center gap-3 px-4 py-3 text-sm"
								>
									{href ? (
										<Link href={href} className="font-medium hover:underline">
											{service.stack?.name}
										</Link>
									) : (
										<span className="font-medium">{service.stack?.name}</span>
									)}
									<Badge variant="outline">
										{service.engine} {service.version}
									</Badge>
									{env && (
										<span className="truncate text-xs text-muted-foreground">
											{env.project?.name} / {env.name}
										</span>
									)}
									<Badge
										variant={statusVariant(service.stack?.composeStatus)}
										className="ml-auto"
									>
										{service.stack?.composeStatus ?? "idle"}
									</Badge>
									<DialogAction
										title="Stop managing this service?"
										description="The stack keeps running; it just leaves this list. Delete the stack from its project to remove it."
										type="destructive"
										onClick={async () => {
											await forget
												.mutateAsync({ id: service.id })
												.then(async () => {
													await utils.engines.list.invalidate();
												})
												.catch(fail);
										}}
									>
										<Button
											variant="ghost"
											size="icon-sm"
											aria-label="Stop managing"
											title="Stop managing"
										>
											<Trash2 className="size-4" />
										</Button>
									</DialogAction>
								</li>
							);
						})}
					</ul>
				</div>
			)}

			{groups.map((group) => (
				<div key={group.id} className="flex flex-col gap-2">
					<h2 className="flex items-center gap-2 text-sm font-medium">
						{group.label}
						<InfoTooltip content={group.hint} />
					</h2>
					<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
						{group.engines.map((engine) => (
							<div
								key={engine.id}
								className="flex flex-col gap-2 rounded-md border p-4"
							>
								<div className="flex items-center justify-between gap-2">
									<span className="font-medium">{engine.label}</span>
									<Button
										variant="outline"
										size="sm"
										onClick={() => setChosen(engine)}
									>
										<Plus className="size-4" />
										Add
									</Button>
								</div>
								<p className="text-xs text-muted-foreground">
									{engine.description}
								</p>
								<p className="text-xs">
									<span className="font-medium">Good for: </span>
									<span className="text-muted-foreground">{engine.useFor}</span>
								</p>
							</div>
						))}
					</div>
				</div>
			))}

			<CreateService engine={chosen} onDone={() => setChosen(null)} />

			<DatabaseTools />
		</section>
	);
};
