import {
	BookOpen,
	ChevronsUpDown,
	CircleHelp,
	ExternalLink,
	User,
} from "lucide-react";
import { useRouter } from "next/router";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { authClient } from "@/lib/auth-client";
import { getFallbackAvatarInitials } from "@/lib/utils";
import { api } from "@/utils/api";
import { ModeToggle } from "../ui/modeToggle";
import { SidebarMenuButton } from "../ui/sidebar";

export const UserNav = () => {
	const router = useRouter();
	const { data } = api.user.get.useQuery();
	const { data: version } = api.settings.getDokployVersion.useQuery(undefined, {
		staleTime: Number.POSITIVE_INFINITY,
	});
	const name =
		`${data?.user?.firstName ?? ""} ${data?.user?.lastName ?? ""}`.trim();
	const { data: whitelabeling } = api.whitelabeling.get.useQuery(undefined, {
		staleTime: 5 * 60 * 1000,
		refetchOnWindowFocus: false,
	});

	const docsUrl =
		whitelabeling?.docsUrl || "https://docs.dokploy.com/docs/core";
	const supportUrl =
		whitelabeling?.supportUrl || "https://discord.gg/2tBnJ3jDJc";

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<SidebarMenuButton
					size="lg"
					className="h-11 data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
				>
					<Avatar className="size-7 rounded-full">
						<AvatarImage
							className="object-cover"
							src={data?.user?.image || ""}
							alt={data?.user?.image || ""}
						/>
						<AvatarFallback className="rounded-full text-[11px]">
							{getFallbackAvatarInitials(name)}
						</AvatarFallback>
					</Avatar>
					<div className="grid flex-1 text-left text-sm leading-tight">
						<span className="truncate text-[13px] font-medium">
							{name || "Account"}
						</span>
						<span className="truncate text-xs text-muted-foreground">
							{data?.user?.email}
						</span>
					</div>
					<ChevronsUpDown className="ml-auto size-4 text-muted-foreground" />
				</SidebarMenuButton>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				className="w-[--radix-dropdown-menu-trigger-width] min-w-64 rounded-lg"
				side="bottom"
				align="end"
				sideOffset={4}
			>
				<div className="flex items-center justify-between px-2 py-1.5">
					{/* DropdownMenuLabel uppercases its contents, which suits a section
					    heading but not a name or an email address. */}
					<DropdownMenuLabel className="flex flex-col normal-case">
						My account
						<span className="text-xs font-normal text-muted-foreground">
							{data?.user?.email}
						</span>
					</DropdownMenuLabel>
					<ModeToggle />
				</div>
				<DropdownMenuSeparator />
				<DropdownMenuGroup>
					<DropdownMenuItem
						className="cursor-pointer"
						onClick={() => router.push("/dashboard/settings/profile")}
					>
						<User className="mr-2 size-4 text-muted-foreground" />
						Profile
					</DropdownMenuItem>
				</DropdownMenuGroup>
				<DropdownMenuSeparator />
				<DropdownMenuGroup>
					<DropdownMenuItem asChild className="cursor-pointer">
						<a href={docsUrl} target="_blank" rel="noopener noreferrer">
							<BookOpen className="mr-2 size-4 text-muted-foreground" />
							Docs
							<ExternalLink className="ml-auto size-3 text-muted-foreground" />
						</a>
					</DropdownMenuItem>
					<DropdownMenuItem asChild className="cursor-pointer">
						<a href={supportUrl} target="_blank" rel="noopener noreferrer">
							<CircleHelp className="mr-2 size-4 text-muted-foreground" />
							Support
							<ExternalLink className="ml-auto size-3 text-muted-foreground" />
						</a>
					</DropdownMenuItem>
				</DropdownMenuGroup>
				<DropdownMenuSeparator />
				{version && (
					<>
						<DropdownMenuLabel className="font-mono text-[11px] font-normal normal-case text-muted-foreground">
							Dokploy {String(version).replace(/^v?/i, "v")}
						</DropdownMenuLabel>
						<DropdownMenuSeparator />
					</>
				)}
				<DropdownMenuItem
					className="cursor-pointer"
					onClick={async () => {
						await authClient.signOut().then(() => {
							router.push("/");
						});
					}}
				>
					Log out
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
};
