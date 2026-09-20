import { Plus, Settings2, Trash2, UsersRound } from "lucide-react";
import { useEffect, useState } from "react";
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
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { api, type RouterOutputs } from "@/utils/api";
import { GrantsEditor } from "./grants-editor";

type Team = RouterOutputs["access"]["teams"]["list"][number];

const CreateTeam = () => {
	const utils = api.useUtils();
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const create = api.access.teams.create.useMutation();
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button>
					<Plus className="size-4" />
					New team
				</Button>
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>New team</DialogTitle>
					<DialogDescription>
						Group people, then grant the team access to projects once.
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-3">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="team-name">Name</Label>
						<Input
							id="team-name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="Platform"
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="team-description">Description</Label>
						<Textarea
							id="team-description"
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							placeholder="Owns the shared infrastructure"
						/>
					</div>
				</div>
				<DialogFooter>
					<Button
						disabled={!name.trim()}
						isLoading={create.isPending}
						onClick={async () => {
							await create
								.mutateAsync({ name, description: description || undefined })
								.then(async () => {
									await utils.access.teams.invalidate();
									toast.success("Team created");
									setName("");
									setDescription("");
									setOpen(false);
								})
								.catch((error: Error) => toast.error(error.message));
						}}
					>
						Create team
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};

const TeamSheet = ({ team, canEdit }: { team: Team; canEdit: boolean }) => {
	const utils = api.useUtils();
	const { data: members } = api.access.members.list.useQuery();
	const setMembers = api.access.teams.setMembers.useMutation();
	const update = api.access.teams.update.useMutation();
	const manual = team.members
		.filter((m) => m.source === "manual")
		.map((m) => m.userId);
	const synced = team.members.filter((m) => m.source !== "manual");
	const [selected, setSelected] = useState<string[]>(manual);
	const [name, setName] = useState(team.name);

	useEffect(() => {
		setSelected(
			team.members.filter((m) => m.source === "manual").map((m) => m.userId),
		);
		setName(team.name);
	}, [team]);

	return (
		<Sheet>
			<SheetTrigger asChild>
				<Button variant="ghost" size="icon" aria-label={`Manage ${team.name}`}>
					<Settings2 className="size-4" />
				</Button>
			</SheetTrigger>
			<SheetContent className="w-full overflow-y-auto sm:max-w-xl">
				<SheetHeader>
					<SheetTitle>{team.name}</SheetTitle>
					<SheetDescription>
						{team.source === "manual"
							? "Managed here."
							: `Synced from ${team.source.toUpperCase()}; its members are managed by your identity provider.`}
					</SheetDescription>
				</SheetHeader>
				<div className="flex flex-col gap-6 px-4 pb-6">
					{canEdit && team.source === "manual" && (
						<div className="flex items-end gap-2">
							<div className="flex flex-1 flex-col gap-1.5">
								<Label htmlFor={`name-${team.id}`}>Name</Label>
								<Input
									id={`name-${team.id}`}
									value={name}
									onChange={(e) => setName(e.target.value)}
								/>
							</div>
							<Button
								variant="outline"
								disabled={!name.trim() || name === team.name}
								isLoading={update.isPending}
								onClick={async () => {
									await update
										.mutateAsync({
											teamId: team.id,
											name,
											description: team.description ?? undefined,
										})
										.then(() => utils.access.teams.invalidate())
										.catch((error: Error) => toast.error(error.message));
								}}
							>
								Rename
							</Button>
						</div>
					)}

					<div className="flex flex-col gap-2">
						<h4 className="text-sm font-medium">Members</h4>
						{synced.length > 0 && (
							<div className="flex flex-wrap gap-1">
								{synced.map((m) => (
									<Badge key={`${m.userId}-${m.source}`} variant="outline">
										{m.user.email} · {m.source}
									</Badge>
								))}
							</div>
						)}
						<ul className="max-h-64 divide-y overflow-y-auto rounded-md border">
							{members?.map((m) => (
								<li
									key={m.userId}
									className="flex items-center gap-3 px-3 py-2"
								>
									<Checkbox
										id={`tm-${team.id}-${m.userId}`}
										disabled={!canEdit}
										checked={selected.includes(m.userId)}
										onCheckedChange={(on) =>
											setSelected((prev) =>
												on
													? [...prev, m.userId]
													: prev.filter((id) => id !== m.userId),
											)
										}
									/>
									<Label
										htmlFor={`tm-${team.id}-${m.userId}`}
										className="flex-1 font-normal"
									>
										{m.user.name || m.user.email}
										{m.user.name && (
											<span className="ml-2 text-xs text-muted-foreground">
												{m.user.email}
											</span>
										)}
									</Label>
									<Badge variant="outline" className="capitalize">
										{m.role}
									</Badge>
								</li>
							))}
						</ul>
						{canEdit && (
							<div className="flex justify-end">
								<Button
									isLoading={setMembers.isPending}
									disabled={
										[...selected].sort().join() === [...manual].sort().join()
									}
									onClick={async () => {
										await setMembers
											.mutateAsync({ teamId: team.id, userIds: selected })
											.then(async () => {
												await Promise.all([
													utils.access.teams.invalidate(),
													utils.access.members.list.invalidate(),
												]);
												toast.success("Members updated");
											})
											.catch((error: Error) => toast.error(error.message));
									}}
								>
									Save members
								</Button>
							</div>
						)}
					</div>

					<GrantsEditor
						subjectType="team"
						subjectId={team.id}
						canEdit={canEdit}
					/>
				</div>
			</SheetContent>
		</Sheet>
	);
};

export const TeamsTab = () => {
	const utils = api.useUtils();
	const { data: teams, isLoading } = api.access.teams.list.useQuery();
	const { data: me } = api.user.get.useQuery();
	const remove = api.access.teams.remove.useMutation();
	const canEdit = me?.role === "owner" || me?.role === "admin";

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<p className="text-sm text-muted-foreground">
					Grant access to a team once instead of to each person.
				</p>
				{canEdit && <CreateTeam />}
			</div>
			{isLoading ? (
				<p className="py-10 text-center text-sm text-muted-foreground">
					Loading teams…
				</p>
			) : !teams?.length ? (
				<div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-12 text-center">
					<UsersRound className="size-8 text-muted-foreground" />
					<p className="text-sm font-medium">No teams yet</p>
					<p className="max-w-sm text-sm text-muted-foreground">
						Create teams like "Platform" or "Frontend", then give each team a
						role on the projects it works on.
					</p>
				</div>
			) : (
				<div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
					{teams.map((team) => {
						const people = [
							...new Map(team.members.map((m) => [m.userId, m.user])).values(),
						];
						return (
							<div
								key={team.id}
								className="flex flex-col gap-3 rounded-lg border p-4"
							>
								<div className="flex items-start justify-between gap-2">
									<div className="min-w-0">
										<p className="truncate font-medium">{team.name}</p>
										{team.description && (
											<p className="line-clamp-2 text-sm text-muted-foreground">
												{team.description}
											</p>
										)}
									</div>
									<div className="flex shrink-0">
										<TeamSheet team={team} canEdit={canEdit} />
										{canEdit && team.source === "manual" && (
											<DialogAction
												title={`Delete ${team.name}?`}
												description="Members keep their own access; access granted through this team is removed."
												type="destructive"
												onClick={async () => {
													await remove
														.mutateAsync({ teamId: team.id })
														.then(() => utils.access.teams.invalidate())
														.catch((error: Error) =>
															toast.error(error.message),
														);
												}}
											>
												<Button
													variant="ghost"
													size="icon"
													aria-label={`Delete ${team.name}`}
													className="text-destructive hover:text-destructive"
												>
													<Trash2 className="size-4" />
												</Button>
											</DialogAction>
										)}
									</div>
								</div>
								<div className="flex items-center justify-between text-sm text-muted-foreground">
									<span>
										{people.length} member{people.length === 1 ? "" : "s"}
									</span>
									{team.source !== "manual" && (
										<Badge variant="outline" className="uppercase">
											{team.source}
										</Badge>
									)}
								</div>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
};
