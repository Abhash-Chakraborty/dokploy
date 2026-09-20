import { Play, Plus, ScrollText, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { DialogAction } from "@/components/shared/dialog-action";
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
	DialogTrigger,
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
import { Textarea } from "@/components/ui/textarea";
import { api, type RouterOutputs } from "@/utils/api";

type Template = RouterOutputs["ansible"]["templates"][number];
type Project = RouterOutputs["ansible"]["projects"][number];

const fail = (error: Error) => toast.error(error.message);

const EditProject = ({ project }: { project: Project }) => {
	const utils = api.useUtils();
	const [open, setOpen] = useState(false);
	const [file, setFile] = useState(Object.keys(project.files)[0] ?? "");
	const [files, setFiles] = useState(project.files);
	const [newFile, setNewFile] = useState("");
	const save = api.ansible.saveProject.useMutation();
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button variant="outline" size="sm">
					<ScrollText className="size-4" />
					{project.name}
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-3xl">
				<DialogHeader>
					<DialogTitle>{project.name}</DialogTitle>
					<DialogDescription>
						Playbooks and the files they use.
					</DialogDescription>
				</DialogHeader>
				<div className="flex gap-2">
					<Select value={file} onValueChange={setFile}>
						<SelectTrigger className="w-64">
							<SelectValue placeholder="Pick a file" />
						</SelectTrigger>
						<SelectContent>
							{Object.keys(files).map((name) => (
								<SelectItem key={name} value={name}>
									{name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Input
						value={newFile}
						placeholder="new-playbook.yml"
						onChange={(event) => setNewFile(event.target.value)}
					/>
					<Button
						variant="outline"
						onClick={() => {
							if (!newFile) return;
							setFiles({
								...files,
								[newFile]: "- hosts: dokploy\n  tasks: []\n",
							});
							setFile(newFile);
							setNewFile("");
						}}
					>
						<Plus className="size-4" />
					</Button>
				</div>
				<Textarea
					rows={18}
					spellCheck={false}
					className="font-mono text-xs"
					value={files[file] ?? ""}
					onChange={(event) =>
						setFiles({ ...files, [file]: event.target.value })
					}
				/>
				<DialogFooter>
					<Button
						isLoading={save.isPending}
						onClick={async () => {
							await save
								.mutateAsync({
									id: project.id,
									name: project.name,
									description: project.description,
									files,
								})
								.then(async () => {
									toast.success("Saved");
									await utils.ansible.invalidate();
									setOpen(false);
								})
								.catch(fail);
						}}
					>
						Save
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};

const EditTemplate = ({
	projects,
	template,
}: {
	projects: Project[];
	template?: Template;
}) => {
	const utils = api.useUtils();
	const [open, setOpen] = useState(false);
	const [name, setName] = useState(template?.name ?? "");
	const [projectId, setProjectId] = useState(
		template?.projectId ?? projects[0]?.id ?? "",
	);
	const [playbook, setPlaybook] = useState(template?.playbook ?? "ping.yml");
	const [all, setAll] = useState(template?.targets.all ?? true);
	const [become, setBecome] = useState(template?.become ?? true);
	const [cron, setCron] = useState(template?.cronExpression ?? "");
	const { data: servers } = api.server.all.useQuery();
	const [serverIds, setServerIds] = useState<string[]>(
		template?.targets.serverIds ?? [],
	);
	const save = api.ansible.saveTemplate.useMutation();
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				{template ? (
					<Button variant="ghost" size="sm">
						Edit
					</Button>
				) : (
					<Button>
						<Plus className="size-4" />
						New run
					</Button>
				)}
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{template ? "Edit run" : "New run"}</DialogTitle>
					<DialogDescription>
						Check mode reports what would change, without changing it.
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-3">
					<div className="grid gap-3 sm:grid-cols-2">
						<div className="flex flex-col gap-1.5">
							<Label>Name</Label>
							<Input
								value={name}
								onChange={(event) => setName(event.target.value)}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label>Playbook file</Label>
							<Input
								value={playbook}
								onChange={(event) => setPlaybook(event.target.value)}
							/>
						</div>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label>Project</Label>
						<Select value={projectId} onValueChange={setProjectId}>
							<SelectTrigger>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{projects.map((project) => (
									<SelectItem key={project.id} value={project.id}>
										{project.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<div className="flex items-center justify-between rounded-md border p-3">
						<div>
							<p className="text-sm font-medium">Every server</p>
							<p className="text-xs text-muted-foreground">
								Otherwise pick them below.
							</p>
						</div>
						<Switch checked={all} onCheckedChange={setAll} />
					</div>
					{!all && (
						<div className="flex max-h-40 flex-col gap-1 overflow-auto rounded-md border p-2">
							{servers?.map((server) => (
								<label
									key={server.serverId}
									className="flex items-center gap-2 text-sm"
								>
									<input
										type="checkbox"
										checked={serverIds.includes(server.serverId)}
										onChange={(event) =>
											setServerIds(
												event.target.checked
													? [...serverIds, server.serverId]
													: serverIds.filter((id) => id !== server.serverId),
											)
										}
									/>
									{server.name}
								</label>
							))}
						</div>
					)}
					<div className="flex items-center justify-between rounded-md border p-3">
						<p className="text-sm font-medium">Run with sudo (become)</p>
						<Switch checked={become} onCheckedChange={setBecome} />
					</div>
					<div className="flex flex-col gap-1.5">
						<Label>Schedule (cron, optional)</Label>
						<Input
							value={cron}
							placeholder="0 4 * * *"
							onChange={(event) => setCron(event.target.value)}
						/>
					</div>
				</div>
				<DialogFooter>
					<Button
						isLoading={save.isPending}
						onClick={async () => {
							await save
								.mutateAsync({
									id: template?.id,
									name,
									projectId,
									playbook,
									targets: { all, serverIds },
									extraVars: template?.extraVars ?? {},
									checkMode: template?.checkMode ?? true,
									become,
									forks: template?.forks ?? 5,
									limitPattern: null,
									tags: [],
									cronExpression: cron || null,
									timezone: template?.timezone ?? "UTC",
									enabled: true,
								})
								.then(async () => {
									toast.success("Saved");
									await utils.ansible.invalidate();
									setOpen(false);
								})
								.catch(fail);
						}}
					>
						Save
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};

export const AnsibleRuns = () => {
	const utils = api.useUtils();
	const { data: projects } = api.ansible.projects.useQuery();
	const { data: templates } = api.ansible.templates.useQuery();
	const run = api.ansible.run.useMutation();
	const remove = api.ansible.removeTemplate.useMutation();

	const start = async (id: string, checkMode: boolean) => {
		await run
			.mutateAsync({ id, checkMode, limit: null })
			.then((result) =>
				toast.success(
					result.approvalId
						? "Waiting for approval"
						: "Started — follow it in Activity",
				),
			)
			.catch(fail);
	};

	return (
		<section className="flex flex-col gap-4">
			<PageHeader
				icon={<ScrollText className="size-5" />}
				title="Ansible"
				description="Playbooks run in a throwaway container, with host keys pinned."
				actions={
					<div className="flex flex-wrap gap-2">
						{projects?.map((project) => (
							<EditProject key={project.id} project={project} />
						))}
						{projects && projects.length > 0 && (
							<EditTemplate projects={projects} />
						)}
					</div>
				}
			/>

			<ul className="divide-y rounded-md border">
				{templates?.length === 0 && (
					<li className="p-6 text-center text-sm text-muted-foreground">
						No runs yet.
					</li>
				)}
				{templates?.map((template) => (
					<li
						key={template.id}
						className="flex flex-wrap items-center gap-2 px-4 py-3"
					>
						<div className="min-w-0 flex-1">
							<div className="flex items-center gap-2">
								<span className="font-medium">{template.name}</span>
								<code className="text-xs text-muted-foreground">
									{template.playbook}
								</code>
								{template.cronExpression && (
									<Badge variant="outline">{template.cronExpression}</Badge>
								)}
							</div>
							<p className="text-xs text-muted-foreground">
								{template.targets.all
									? "Every server"
									: `${template.targets.serverIds.length} server(s)`}
								{template.become ? " · sudo" : ""}
							</p>
						</div>
						<Button
							variant="outline"
							size="sm"
							onClick={() => start(template.id, true)}
						>
							Check
						</Button>
						<Button size="sm" onClick={() => start(template.id, false)}>
							<Play className="size-4" />
							Apply
						</Button>
						{projects && (
							<EditTemplate projects={projects} template={template} />
						)}
						<DialogAction
							title={`Delete ${template.name}?`}
							description="The playbook itself stays in its project."
							type="destructive"
							onClick={async () => {
								await remove
									.mutateAsync({ id: template.id })
									.then(async () => {
										toast.success("Deleted");
										await utils.ansible.invalidate();
									})
									.catch(fail);
							}}
						>
							<Button
								variant="ghost"
								size="icon"
								className="text-destructive hover:text-destructive"
								aria-label={`Delete ${template.name}`}
							>
								<Trash2 className="size-4" />
							</Button>
						</DialogAction>
					</li>
				))}
			</ul>
		</section>
	);
};
