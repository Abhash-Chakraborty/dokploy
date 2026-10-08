import {
	ArrowUpDown,
	Loader2,
	MoreHorizontalIcon,
	Search,
	TrashIcon,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/router";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { BreadcrumbSidebar } from "@/components/shared/breadcrumb-sidebar";
import { DateTooltip } from "@/components/shared/date-tooltip";
import { FocusShortcutInput } from "@/components/shared/focus-shortcut-input";
import { useLiveServices } from "@/components/shared/live-status";
import { PageHeader } from "@/components/shared/page-header";
import { TagBadge } from "@/components/shared/tag-badge";
import { TagFilter } from "@/components/shared/tag-filter";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { extractServices } from "@/lib/services";
import { api } from "@/utils/api";
import { useDebounce } from "@/utils/hooks/use-debounce";
import { HandleProject } from "./handle-project";
import { ProjectEnvironment } from "./project-environment";

export const ShowProjects = () => {
	const utils = api.useUtils();
	const router = useRouter();
	const { data: isCloud } = api.settings.isCloud.useQuery();
	const { data, isPending } = api.project.all.useQuery();
	const { data: auth } = api.user.get.useQuery();
	const { data: permissions } = api.user.getPermissions.useQuery();
	const { mutateAsync } = api.project.remove.useMutation();
	const { data: availableTags } = api.tag.all.useQuery();

	const [searchQuery, setSearchQuery] = useState(
		router.isReady && typeof router.query.q === "string" ? router.query.q : "",
	);
	const debouncedSearchQuery = useDebounce(searchQuery, 500);

	const [sortBy, setSortBy] = useState<string>(() => {
		if (typeof window !== "undefined") {
			return localStorage.getItem("projectsSort") || "createdAt-desc";
		}
		return "createdAt-desc";
	});

	const [selectedTagIds, setSelectedTagIds] = useState<string[]>(() => {
		if (typeof window !== "undefined") {
			const saved = localStorage.getItem("projectsTagFilter");
			return saved ? JSON.parse(saved) : [];
		}
		return [];
	});

	useEffect(() => {
		localStorage.setItem("projectsSort", sortBy);
	}, [sortBy]);

	useEffect(() => {
		localStorage.setItem("projectsTagFilter", JSON.stringify(selectedTagIds));
	}, [selectedTagIds]);

	useEffect(() => {
		if (!availableTags) return;
		const validIds = new Set(availableTags.map((t) => t.tagId));
		setSelectedTagIds((prev) => {
			const filtered = prev.filter((id) => validIds.has(id));
			return filtered.length === prev.length ? prev : filtered;
		});
	}, [availableTags]);

	useEffect(() => {
		if (!router.isReady) return;
		const urlQuery = typeof router.query.q === "string" ? router.query.q : "";
		if (urlQuery !== searchQuery) {
			setSearchQuery(urlQuery);
		}
	}, [router.isReady, router.query.q]);

	useEffect(() => {
		if (!router.isReady) return;
		const urlQuery = typeof router.query.q === "string" ? router.query.q : "";
		if (debouncedSearchQuery === urlQuery) return;

		const newQuery = { ...router.query };
		if (debouncedSearchQuery) {
			newQuery.q = debouncedSearchQuery;
		} else {
			delete newQuery.q;
		}
		router.replace({ pathname: router.pathname, query: newQuery }, undefined, {
			shallow: true,
		});
	}, [debouncedSearchQuery]);

	const filteredProjects = useMemo(() => {
		if (!data) return [];

		let filtered = data.filter(
			(project) =>
				project.name
					.toLowerCase()
					.includes(debouncedSearchQuery.toLowerCase()) ||
				project.description
					?.toLowerCase()
					.includes(debouncedSearchQuery.toLowerCase()),
		);

		// Filter by selected tags (OR logic: show projects with ANY selected tag)
		if (selectedTagIds.length > 0) {
			filtered = filtered.filter((project) =>
				project.projectTags?.some((pt) =>
					selectedTagIds.includes(pt.tag.tagId),
				),
			);
		}

		// Then sort the filtered results
		const [field, direction] = sortBy.split("-");
		return [...filtered].sort((a, b) => {
			let comparison = 0;
			switch (field) {
				case "name":
					comparison = a.name.localeCompare(b.name);
					break;
				case "createdAt":
					comparison =
						new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
					break;
				case "services": {
					const aTotalServices = a.environments.reduce((total, env) => {
						return (
							total +
							(env.applications?.length || 0) +
							(env.libsql?.length || 0) +
							(env.mariadb?.length || 0) +
							(env.mongo?.length || 0) +
							(env.mysql?.length || 0) +
							(env.postgres?.length || 0) +
							(env.redis?.length || 0) +
							(env.compose?.length || 0)
						);
					}, 0);
					const bTotalServices = b.environments.reduce((total, env) => {
						return (
							total +
							(env.applications?.length || 0) +
							(env.libsql?.length || 0) +
							(env.mariadb?.length || 0) +
							(env.mongo?.length || 0) +
							(env.mysql?.length || 0) +
							(env.postgres?.length || 0) +
							(env.redis?.length || 0) +
							(env.compose?.length || 0)
						);
					}, 0);
					comparison = aTotalServices - bTotalServices;
					break;
				}
				default:
					comparison = 0;
			}
			return direction === "asc" ? comparison : -comparison;
		});
	}, [data, debouncedSearchQuery, sortBy, selectedTagIds]);

	const liveState = useLiveServices();

	return (
		<>
			<BreadcrumbSidebar
				list={[{ name: "Projects", href: "/dashboard/projects" }]}
			/>
			<div className="flex w-full flex-col gap-6">
				<PageHeader
					title="Projects"
					description={
						data
							? `${data.length} ${data.length === 1 ? "project" : "projects"}`
							: "Create and manage your projects."
					}
					actions={permissions?.project.create ? <HandleProject /> : undefined}
				/>
				{isPending ? (
					<div className="flex items-center gap-2 py-16 text-[13px] text-muted-foreground">
						<Loader2 className="size-4 animate-spin" /> Loading projects…
					</div>
				) : (
					<>
						<div className="flex flex-wrap items-center gap-2">
							<div className="relative w-full sm:w-80">
								<Search className="pointer-events-none absolute left-2.5 top-2 size-4 text-muted-foreground" />
								<FocusShortcutInput
									placeholder="Filter projects"
									value={searchQuery}
									onChange={(e) => setSearchQuery(e.target.value)}
									className="pl-8"
								/>
							</div>
							<TagFilter
								tags={
									availableTags?.map((tag) => ({
										id: tag.tagId,
										name: tag.name,
										color: tag.color || undefined,
									})) || []
								}
								selectedTags={selectedTagIds}
								onTagsChange={setSelectedTagIds}
							/>
							<Select value={sortBy} onValueChange={setSortBy}>
								<SelectTrigger className="w-44" aria-label="Sort projects">
									<ArrowUpDown className="size-3.5 text-muted-foreground" />
									<SelectValue placeholder="Sort by" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="name-asc">Name (A-Z)</SelectItem>
									<SelectItem value="name-desc">Name (Z-A)</SelectItem>
									<SelectItem value="createdAt-desc">Newest first</SelectItem>
									<SelectItem value="createdAt-asc">Oldest first</SelectItem>
									<SelectItem value="services-desc">Most services</SelectItem>
									<SelectItem value="services-asc">Fewest services</SelectItem>
								</SelectContent>
							</Select>
						</div>

						{filteredProjects.length === 0 ? (
							<div className="flex flex-col items-start gap-2 py-12">
								<span className="text-[15px] font-semibold">
									{data?.length ? "No projects match" : "No projects yet"}
								</span>
								<span className="text-[13px] text-muted-foreground">
									{data?.length
										? "Try another name or clear the tag filter."
										: "A project groups the apps, databases and stacks that belong together."}
								</span>
							</div>
						) : (
							<div className="overflow-x-auto">
								<table className="w-full min-w-[640px] text-[13px]">
									<thead>
										<tr className="text-left text-xs text-muted-foreground">
											<th className="h-9 pr-4 font-medium">Name</th>
											<th className="h-9 pr-4 font-medium">Services</th>
											<th className="h-9 pr-4 font-medium">Environments</th>
											<th className="h-9 pr-4 font-medium">Created</th>
											<th className="h-9 w-10" />
										</tr>
									</thead>
									<tbody>
										{filteredProjects.map((project) => {
											const services = project.environments.flatMap((env) =>
												extractServices(env as never),
											);
											const tally = {
												running: 0,
												restarting: 0,
												failed: 0,
												stopped: 0,
												deploying: 0,
											};
											for (const service of services) {
												tally[
													liveState(
														service.appName,
														service.serverId,
														service.status,
													).tone
												] += 1;
											}
											const environment =
												project.environments.find((env) => env.isDefault) ||
												project.environments[0];
											const href = environment
												? `/dashboard/project/${project.projectId}/environment/${environment.environmentId}`
												: undefined;
											return (
												<tr
													key={project.projectId}
													className="group relative border-b border-border/60 transition-colors hover:bg-muted/40"
												>
													<td className="py-3 pr-4">
														{href ? (
															<Link
																href={href}
																className="font-medium after:absolute after:inset-0 focus-visible:outline-none"
															>
																{project.name}
															</Link>
														) : (
															<span className="font-medium">
																{project.name}
															</span>
														)}
														{(project.description || !href) && (
															<p className="mt-0.5 text-xs text-muted-foreground">
																{href
																	? project.description
																	: "No environment you can open"}
															</p>
														)}
														{project.projectTags?.length > 0 && (
															<div className="mt-1.5 flex flex-wrap gap-1">
																{project.projectTags.map((pt) => (
																	<TagBadge
																		key={pt.tag.tagId}
																		name={pt.tag.name}
																		color={pt.tag.color}
																	/>
																))}
															</div>
														)}
													</td>
													<td className="py-3 pr-4">
														<ServiceTally
															tally={tally}
															total={services.length}
														/>
													</td>
													<td className="py-3 pr-4 text-muted-foreground">
														{project.environments.length}
													</td>
													<td className="py-3 pr-4 text-muted-foreground">
														<DateTooltip date={project.createdAt} />
													</td>
													<td className="relative z-10 py-3 text-right">
														<ProjectActions
															projectId={project.projectId}
															canDelete={!!permissions?.project.delete}
															isEmpty={services.length === 0}
															onDeleted={() => utils.project.all.invalidate()}
															onDelete={mutateAsync}
														/>
													</td>
												</tr>
											);
										})}
									</tbody>
								</table>
							</div>
						)}
					</>
				)}
			</div>
		</>
	);
};

const ServiceTally = ({
	tally,
	total,
}: {
	tally: Record<
		"running" | "restarting" | "failed" | "stopped" | "deploying",
		number
	>;
	total: number;
}) => {
	if (total === 0) return <span className="text-muted-foreground">Empty</span>;
	const parts = [
		{
			key: "failed",
			label: "down",
			dot: "bg-status-failed",
			text: "text-status-failed",
		},
		{
			key: "restarting",
			label: "restarting",
			dot: "bg-status-restarting",
			text: "text-status-restarting",
		},
		{
			key: "deploying",
			label: "deploying",
			dot: "bg-status-deploying",
			text: "",
		},
		{ key: "running", label: "running", dot: "bg-status-running", text: "" },
		{
			key: "stopped",
			label: "stopped",
			dot: "bg-status-stopped",
			text: "text-muted-foreground",
		},
	] as const;
	return (
		<span className="flex flex-wrap items-center gap-x-3 gap-y-1">
			{parts
				.filter((part) => tally[part.key] > 0)
				.map((part) => (
					<span
						key={part.key}
						className={`inline-flex items-center gap-1.5 ${part.text}`}
					>
						<span className={`size-1.5 rounded-full ${part.dot}`} />
						{tally[part.key]} {part.label}
					</span>
				))}
		</span>
	);
};

const ProjectActions = ({
	projectId,
	canDelete,
	isEmpty,
	onDelete,
	onDeleted,
}: {
	projectId: string;
	canDelete: boolean;
	isEmpty: boolean;
	onDelete: (input: { projectId: string }) => Promise<unknown>;
	onDeleted: () => void;
}) => (
	<DropdownMenu>
		<DropdownMenuTrigger asChild>
			<Button variant="ghost" size="icon-sm" aria-label="Project actions">
				<MoreHorizontalIcon className="size-4" />
			</Button>
		</DropdownMenuTrigger>
		<DropdownMenuContent align="end" className="w-52">
			<ProjectEnvironment projectId={projectId} />
			<HandleProject projectId={projectId} />
			{canDelete && (
				<AlertDialog>
					<AlertDialogTrigger asChild>
						<DropdownMenuItem
							variant="destructive"
							onSelect={(event) => event.preventDefault()}
						>
							<TrashIcon className="size-4" />
							Delete project
						</DropdownMenuItem>
					</AlertDialogTrigger>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>Delete this project?</AlertDialogTitle>
							{isEmpty ? (
								<AlertDialogDescription>
									This cannot be undone.
								</AlertDialogDescription>
							) : (
								<AlertBlock type="warning">
									It still has services. Delete them first.
								</AlertBlock>
							)}
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogCancel>Cancel</AlertDialogCancel>
							<AlertDialogAction
								disabled={!isEmpty}
								onClick={async () => {
									await onDelete({ projectId })
										.then(() => toast.success("Project deleted"))
										.catch(() => toast.error("The project was not deleted"))
										.finally(onDeleted);
								}}
							>
								Delete
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			)}
		</DropdownMenuContent>
	</DropdownMenu>
);
