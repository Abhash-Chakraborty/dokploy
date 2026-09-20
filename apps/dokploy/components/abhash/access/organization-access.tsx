import { Users } from "lucide-react";
import { useRouter } from "next/router";
import { AddInvitation } from "@/components/dashboard/settings/users/add-invitation";
import { ShowInvitations } from "@/components/dashboard/settings/users/show-invitations";
import { PageHeader } from "@/components/shared/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/utils/api";
import { EngineSwitch } from "./engine-switch";
import { MembersTab } from "./members-tab";
import { RolesTab } from "./roles-tab";
import { TeamsTab } from "./teams-tab";

const TABS = ["members", "teams", "roles", "invitations"] as const;
type Tab = (typeof TABS)[number];

export const OrganizationAccess = () => {
	const router = useRouter();
	const { data: me } = api.user.get.useQuery();
	const { data: permissions } = api.user.getPermissions.useQuery();
	const isAdmin = me?.role === "owner" || me?.role === "admin";
	const canInvite = !!permissions?.member.create;
	const current = (TABS as readonly string[]).includes(String(router.query.tab))
		? (router.query.tab as Tab)
		: "members";

	return (
		<>
			<PageHeader
				title="Members & access"
				description="Who is in this organization, their teams, and what they can reach."
				icon={<Users className="size-5" />}
				actions={canInvite ? <AddInvitation /> : undefined}
			/>
			<EngineSwitch />
			<Tabs
				value={current}
				onValueChange={(tab) =>
					router.replace({ query: { ...router.query, tab } }, undefined, {
						shallow: true,
					})
				}
			>
				<TabsList>
					<TabsTrigger value="members">Members</TabsTrigger>
					<TabsTrigger value="teams">Teams</TabsTrigger>
					<TabsTrigger value="roles">Roles</TabsTrigger>
					{canInvite && (
						<TabsTrigger value="invitations">Invitations</TabsTrigger>
					)}
				</TabsList>
				<TabsContent value="members" className="pt-4">
					<MembersTab />
				</TabsContent>
				<TabsContent value="teams" className="pt-4">
					<TeamsTab />
				</TabsContent>
				<TabsContent value="roles" className="pt-4">
					<RolesTab canEdit={isAdmin} />
				</TabsContent>
				{canInvite && (
					<TabsContent value="invitations" className="pt-4">
						<ShowInvitations />
					</TabsContent>
				)}
			</Tabs>
		</>
	);
};
