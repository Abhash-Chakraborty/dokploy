import { ChevronDown, Plus } from "lucide-react";
import { useRouter } from "next/router";
import { useMemo, useState } from "react";
import {
	extractServices,
	type Services,
} from "@/components/dashboard/settings/users/add-permissions";
import { Button } from "@/components/ui/button";
import {
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api } from "@/utils/api";

type Mode = "database" | "volume";

const DATABASE_TYPES = new Set<Services["type"]>([
	"postgres",
	"mysql",
	"mariadb",
	"mongo",
	"libsql",
	"compose",
]);
const VOLUME_TYPES = new Set<Services["type"]>(["application", "compose"]);

// Each service's own tab holds the create form, so picking a service jumps
// there instead of duplicating the per-engine options in this menu.
const tabFor = (mode: Mode, type: Services["type"]) =>
	mode === "volume" && type === "application" ? "volume-backups" : "backups";

export const NewBackupMenu = ({ onDokploy }: { onDokploy: () => void }) => {
	const router = useRouter();
	const [mode, setMode] = useState<Mode | null>(null);
	const { data: projects } = api.project.all.useQuery(undefined, {
		enabled: mode !== null,
	});

	const groups = useMemo(() => {
		if (!projects || !mode) return [];
		const allowed = mode === "database" ? DATABASE_TYPES : VOLUME_TYPES;
		return projects
			.map((project) => ({
				project,
				services: project.environments.flatMap((environment) =>
					extractServices(environment as never)
						.filter((service) => allowed.has(service.type))
						.map((service) => ({
							...service,
							environmentId: environment.environmentId,
							environmentName: environment.name,
						})),
				),
			}))
			.filter((group) => group.services.length > 0);
	}, [projects, mode]);

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button>
						<Plus className="size-4" />
						New backup
						<ChevronDown className="size-3.5 opacity-70" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-64">
					<DropdownMenuItem
						className="flex-col items-start gap-0.5"
						onSelect={() => setMode("database")}
					>
						<span>A database</span>
						<span className="text-xs text-muted-foreground">
							Scheduled dump of Postgres, MySQL, MariaDB, Mongo or a compose
							database
						</span>
					</DropdownMenuItem>
					<DropdownMenuItem
						className="flex-col items-start gap-0.5"
						onSelect={() => setMode("volume")}
					>
						<span>A volume</span>
						<span className="text-xs text-muted-foreground">
							Files in an app's or compose stack's volume
						</span>
					</DropdownMenuItem>
					<DropdownMenuItem
						className="flex-col items-start gap-0.5"
						onSelect={onDokploy}
					>
						<span>Dokploy itself</span>
						<span className="text-xs text-muted-foreground">
							The panel's own database and settings
						</span>
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>

			<CommandDialog
				open={mode !== null}
				onOpenChange={(open) => !open && setMode(null)}
				title={mode === "volume" ? "Back up a volume" : "Back up a database"}
				description="Pick the service; its backup settings open next."
			>
				<CommandInput
					placeholder={
						mode === "volume"
							? "Find an app or compose stack"
							: "Find a database or compose stack"
					}
				/>
				<CommandList>
					<CommandEmpty>Nothing matches.</CommandEmpty>
					{groups.map(({ project, services }) => (
						<CommandGroup key={project.projectId} heading={project.name}>
							{services.map((service) => (
								<CommandItem
									key={service.id}
									value={`${project.name} ${service.environmentName} ${service.name} ${service.type}`}
									onSelect={() => {
										const target = `/dashboard/project/${project.projectId}/environment/${service.environmentId}/services/${service.type}/${service.id}?tab=${tabFor(mode ?? "database", service.type)}`;
										setMode(null);
										router.push(target);
									}}
								>
									<span>{service.name}</span>
									<span className="ml-auto text-xs text-muted-foreground">
										{service.type} · {service.environmentName}
									</span>
								</CommandItem>
							))}
						</CommandGroup>
					))}
				</CommandList>
			</CommandDialog>
		</>
	);
};
