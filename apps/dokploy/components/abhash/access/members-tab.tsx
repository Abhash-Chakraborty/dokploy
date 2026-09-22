import { format } from "date-fns";
import {
	Ban,
	Crown,
	KeyRound,
	Lock,
	LockOpen,
	MoreHorizontal,
	RotateCcw,
	ShieldCheck,
	UserMinus,
} from "lucide-react";
import { toast } from "sonner";
import { AddUserPermissions } from "@/components/dashboard/settings/users/add-permissions";
import { ChangeRole } from "@/components/dashboard/settings/users/change-role";
import { DialogAction } from "@/components/shared/dialog-action";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { api } from "@/utils/api";
import { MemberAccessSheet } from "./member-access-sheet";

const ROLE_VARIANT: Record<string, "default" | "secondary" | "outline"> = {
	owner: "default",
	admin: "secondary",
};

const initials = (name: string, email: string) =>
	(name || email)
		.split(/[\s@.]+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((part) => part[0]?.toUpperCase())
		.join("");

export const MembersTab = () => {
	const utils = api.useUtils();
	const { data: members, isLoading } = api.access.members.list.useQuery();
	const { data: me } = api.user.get.useQuery();
	const { data: permissions } = api.user.getPermissions.useQuery();
	const { data: status } = api.access.status.useQuery();
	const suspend = api.access.members.suspend.useMutation();
	const reactivate = api.access.members.reactivate.useMutation();
	const pin = api.access.members.setRolePinned.useMutation();
	const removeMember = api.access.members.remove.useMutation();
	const transferOwnership = api.access.members.transferOwnership.useMutation();

	const isOwnerMe = me?.role === "owner";
	const isAdmin = isOwnerMe || me?.role === "admin";
	const canChangeRole = !!permissions?.member.update;
	const canRemove = !!permissions?.member.delete;

	const refresh = () =>
		Promise.all([
			utils.access.members.list.invalidate(),
			utils.user.all.invalidate(),
			utils.user.get.invalidate(),
		]);

	if (isLoading) {
		return (
			<p className="py-10 text-center text-sm text-muted-foreground">
				Loading members…
			</p>
		);
	}

	return (
		<div className="overflow-x-auto rounded-lg border">
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Member</TableHead>
						<TableHead>Role</TableHead>
						<TableHead className="hidden md:table-cell">Teams</TableHead>
						<TableHead className="hidden lg:table-cell">Status</TableHead>
						<TableHead className="hidden lg:table-cell">Joined</TableHead>
						<TableHead className="w-10" />
					</TableRow>
				</TableHeader>
				<TableBody>
					{members?.map((m) => {
						const isSelf = m.userId === me?.user.id;
						const isOwner = m.role === "owner";
						const suspended = !!m.suspension || !!m.user.banned;
						return (
							<TableRow
								key={m.memberId}
								className={suspended ? "opacity-60" : ""}
							>
								<TableCell>
									<div className="flex items-center gap-3">
										<Avatar className="size-8">
											<AvatarImage src={m.user.image ?? undefined} />
											<AvatarFallback className="text-xs">
												{initials(m.user.name, m.user.email)}
											</AvatarFallback>
										</Avatar>
										<div className="min-w-0">
											<p className="truncate text-sm font-medium">
												{m.user.name || m.user.email}
												{isSelf && (
													<span className="ml-1 text-xs text-muted-foreground">
														(you)
													</span>
												)}
											</p>
											{m.user.name && (
												<p className="truncate text-xs text-muted-foreground">
													{m.user.email}
												</p>
											)}
										</div>
									</div>
								</TableCell>
								<TableCell>
									<div className="flex items-center gap-1">
										<Badge
											variant={ROLE_VARIANT[m.role] ?? "outline"}
											className="capitalize"
										>
											{m.role}
										</Badge>
										{m.rolePinned && (
											<Lock
												className="size-3 text-muted-foreground"
												aria-label="Role locked: SSO sync will not change it"
											/>
										)}
										{m.roleSource !== "manual" && (
											<Badge
												variant="outline"
												className="text-[10px] uppercase"
											>
												{m.roleSource}
											</Badge>
										)}
									</div>
								</TableCell>
								<TableCell className="hidden md:table-cell">
									<div className="flex flex-wrap gap-1">
										{m.teams.length === 0 ? (
											<span className="text-xs text-muted-foreground">—</span>
										) : (
											m.teams.map((t) => (
												<Badge key={t.id} variant="secondary">
													{t.name}
												</Badge>
											))
										)}
									</div>
								</TableCell>
								<TableCell className="hidden lg:table-cell">
									<div className="flex items-center gap-1">
										{suspended ? (
											<Badge variant="destructive">Suspended</Badge>
										) : (
											<Badge variant="outline">Active</Badge>
										)}
										{m.user.twoFactorEnabled && (
											<Badge
												variant="outline"
												title="Two-factor authentication on"
											>
												<KeyRound className="size-3" />
												2FA
											</Badge>
										)}
									</div>
								</TableCell>
								<TableCell className="hidden text-sm text-muted-foreground lg:table-cell">
									{format(new Date(m.createdAt), "PP")}
								</TableCell>
								<TableCell>
									{isOwner || isSelf || !isAdmin ? (
										<MemberAccessSheet
											userId={m.userId}
											name={m.user.name}
											email={m.user.email}
											role={m.role}
											teams={m.teams}
											canEdit={false}
										>
											<Button
												variant="ghost"
												size="icon"
												aria-label="View access"
											>
												<ShieldCheck className="size-4" />
											</Button>
										</MemberAccessSheet>
									) : (
										<DropdownMenu>
											<DropdownMenuTrigger asChild>
												<Button
													variant="ghost"
													size="icon"
													aria-label="Member actions"
												>
													<MoreHorizontal className="size-4" />
												</Button>
											</DropdownMenuTrigger>
											<DropdownMenuContent align="end" className="w-56">
												<DropdownMenuLabel className="truncate font-normal normal-case text-muted-foreground">
													{m.user.email}
												</DropdownMenuLabel>
												<MemberAccessSheet
													userId={m.userId}
													name={m.user.name}
													email={m.user.email}
													role={m.role}
													teams={m.teams}
													canEdit
												>
													<DropdownMenuItem
														onSelect={(e) => e.preventDefault()}
													>
														<ShieldCheck className="size-4" />
														Manage access
													</DropdownMenuItem>
												</MemberAccessSheet>
												{canChangeRole && (
													<ChangeRole
														memberId={m.memberId}
														currentRole={m.role}
														userEmail={m.user.email}
													/>
												)}
												{!status?.rbacV2 && canChangeRole && (
													<AddUserPermissions userId={m.userId} role={m.role} />
												)}
												<DropdownMenuItem
													onSelect={async () => {
														await pin
															.mutateAsync({
																memberId: m.memberId,
																pinned: !m.rolePinned,
															})
															.then(refresh)
															.catch((error: Error) =>
																toast.error(error.message),
															);
													}}
												>
													{m.rolePinned ? (
														<LockOpen className="size-4" />
													) : (
														<Lock className="size-4" />
													)}
													<div className="flex flex-col">
														<span>
															{m.rolePinned ? "Unlock role" : "Lock role"}
														</span>
														<span className="text-xs text-muted-foreground">
															{m.rolePinned
																? "SSO groups can change it again"
																: "SSO groups won't change it"}
														</span>
													</div>
												</DropdownMenuItem>
												{isOwnerMe && !suspended && (
													<DialogAction
														title={`Make ${m.user.email} the owner?`}
														description="They get full control of this organization, including billing and deleting it. You stay on as an admin, and only the new owner can undo this."
														type="destructive"
														onClick={async () => {
															await transferOwnership
																.mutateAsync({ memberId: m.memberId })
																.then(async () => {
																	await refresh();
																	toast.success("Ownership transferred");
																})
																.catch((error: Error) =>
																	toast.error(error.message),
																);
														}}
													>
														<DropdownMenuItem
															onSelect={(e) => e.preventDefault()}
														>
															<Crown className="size-4" />
															Make owner
														</DropdownMenuItem>
													</DialogAction>
												)}
												<DropdownMenuSeparator />
												{suspended ? (
													<DropdownMenuItem
														onSelect={async () => {
															await reactivate
																.mutateAsync({ userId: m.userId })
																.then(async () => {
																	await refresh();
																	toast.success("Member reactivated");
																})
																.catch((error: Error) =>
																	toast.error(error.message),
																);
														}}
													>
														<RotateCcw className="size-4" />
														Reactivate
													</DropdownMenuItem>
												) : (
													<DialogAction
														title={`Suspend ${m.user.email}?`}
														description="They are signed out everywhere, cannot sign in, and their API keys stop working until reactivated. Nothing is deleted."
														type="destructive"
														onClick={async () => {
															await suspend
																.mutateAsync({ userId: m.userId })
																.then(async () => {
																	await refresh();
																	toast.success("Member suspended");
																})
																.catch((error: Error) =>
																	toast.error(error.message),
																);
														}}
													>
														<DropdownMenuItem
															onSelect={(e) => e.preventDefault()}
														>
															<Ban className="size-4" />
															Suspend
														</DropdownMenuItem>
													</DialogAction>
												)}
												{canRemove && (
													<DialogAction
														title={`Remove ${m.user.email}?`}
														description="They lose access to this organization. Their account is kept if they belong to other organizations."
														type="destructive"
														onClick={async () => {
															await removeMember
																.mutateAsync({ memberId: m.memberId })
																.then(async () => {
																	await refresh();
																	toast.success("Member removed");
																})
																.catch((error: Error) =>
																	toast.error(error.message),
																);
														}}
													>
														<DropdownMenuItem
															className="text-destructive focus:text-destructive"
															onSelect={(e) => e.preventDefault()}
														>
															<UserMinus className="size-4" />
															Remove from organization
														</DropdownMenuItem>
													</DialogAction>
												)}
											</DropdownMenuContent>
										</DropdownMenu>
									)}
								</TableCell>
							</TableRow>
						);
					})}
				</TableBody>
			</Table>
		</div>
	);
};
