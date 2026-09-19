import { ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/utils/api";
import { ExplainAccess } from "./explain-access";
import { GrantsEditor } from "./grants-editor";

type Props = {
	userId: string;
	name: string;
	email: string;
	role: string;
	teams: { id: string; name: string }[];
	canEdit: boolean;
	children: ReactNode;
};

export const MemberAccessSheet = ({
	userId,
	name,
	email,
	role,
	teams,
	canEdit,
	children,
}: Props) => {
	const { data: status } = api.access.status.useQuery();
	const privileged = role === "owner" || role === "admin";

	return (
		<Sheet>
			<SheetTrigger asChild>{children}</SheetTrigger>
			<SheetContent className="w-full overflow-y-auto sm:max-w-xl">
				<SheetHeader>
					<SheetTitle className="flex items-center gap-2">
						<ShieldCheck className="size-5" />
						{name || email}
					</SheetTitle>
					<SheetDescription>
						{email} · organization role <strong>{role}</strong>
					</SheetDescription>
				</SheetHeader>
				<div className="flex flex-col gap-4 px-4 pb-6">
					{privileged ? (
						<p className="rounded-md border bg-muted/30 p-3 text-sm">
							Owners and admins can reach every project, so per-project grants
							do not apply to them. Change the organization role to limit
							access.
						</p>
					) : !status?.rbacV2 ? (
						<p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
							Grants take effect once the owner turns on per-project access
							(Organization → Members). Until then the legacy permission editor
							applies.
						</p>
					) : null}

					{!privileged && (
						<Tabs defaultValue="grants">
							<TabsList>
								<TabsTrigger value="grants">Access</TabsTrigger>
								<TabsTrigger value="effective">Effective access</TabsTrigger>
							</TabsList>
							<TabsContent value="grants" className="flex flex-col gap-4 pt-2">
								<GrantsEditor
									subjectType="user"
									subjectId={userId}
									canEdit={canEdit}
								/>
								{teams.length > 0 && (
									<div className="flex flex-col gap-2">
										<h4 className="text-sm font-medium">Through teams</h4>
										<div className="flex flex-wrap gap-1">
											{teams.map((t) => (
												<Badge key={t.id} variant="outline">
													{t.name}
												</Badge>
											))}
										</div>
										<p className="text-xs text-muted-foreground">
											Team access is managed on the Teams tab.
										</p>
									</div>
								)}
							</TabsContent>
							<TabsContent value="effective" className="pt-2">
								<ExplainAccess userId={userId} />
							</TabsContent>
						</Tabs>
					)}
				</div>
			</SheetContent>
		</Sheet>
	);
};
