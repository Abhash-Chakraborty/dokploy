import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { CircleHelp, Pencil, PlusIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { AlertBlock } from "@/components/shared/alert-block";
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
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import {
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/utils/api";

const Schema = z.object({
	name: z.string().min(1, {
		message: "Name is required",
	}),
	description: z.string().optional(),
	ipAddress: z.string().min(1, {
		message: "IP Address is required",
	}),
	port: z.number().optional(),
	username: z.string().optional(),
	sshKeyId: z.string().min(1, {
		message: "SSH Key is required",
	}),
	serverType: z.enum(["deploy", "build"]).default("deploy"),
	enableDockerCleanup: z.boolean().default(true),
});

type Schema = z.infer<typeof Schema>;

interface Props {
	serverId?: string;
	asButton?: boolean;
}

export const HandleServers = ({ serverId, asButton = false }: Props) => {
	const utils = api.useUtils();
	const [isOpen, setIsOpen] = useState(false);
	const { data: canCreateMoreServers, refetch } =
		api.stripe.canCreateMoreServers.useQuery();

	const { data, refetch: refetchServer } = api.server.one.useQuery(
		{
			serverId: serverId || "",
		},
		{
			enabled: !!serverId,
		},
	);

	const { data: sshKeys } = api.sshKey.all.useQuery();
	const { mutateAsync, error, isPending, isError } = serverId
		? api.server.update.useMutation()
		: api.server.create.useMutation();
	const form = useForm({
		defaultValues: {
			description: "",
			name: "",
			ipAddress: "",
			port: 22,
			username: "root",
			sshKeyId: "",
			serverType: "deploy",
			enableDockerCleanup: true,
		},
		resolver: zodResolver(Schema),
	});

	useEffect(() => {
		form.reset({
			description: data?.description || "",
			name: data?.name || "",
			ipAddress: data?.ipAddress || "",
			port: data?.port || 22,
			username: data?.username || "root",
			sshKeyId: data?.sshKeyId || "",
			serverType: data?.serverType || "deploy",
			enableDockerCleanup: data?.enableDockerCleanup ?? true,
		});
	}, [form, form.reset, form.formState.isSubmitSuccessful, data]);

	useEffect(() => {
		refetch();
	}, [isOpen]);

	const onSubmit = async (data: Schema) => {
		await mutateAsync({
			name: data.name,
			description: data.description || "",
			ipAddress: data.ipAddress?.trim() || "",
			port: data.port || 22,
			username: data.username || "root",
			sshKeyId: data.sshKeyId || "",
			serverType: data.serverType || "deploy",
			enableDockerCleanup: data.enableDockerCleanup,
			serverId: serverId || "",
		})
			.then(async (_data) => {
				await utils.server.all.invalidate();
				refetchServer();
				toast.success(serverId ? "Server Updated" : "Server Created");
				setIsOpen(false);
			})
			.catch(() => {
				toast.error(
					serverId ? "Error updating a server" : "Error creating a server",
				);
			});
	};

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			{serverId ? (
				asButton ? (
					<DialogTrigger asChild>
						<Button variant="outline" size="icon" className="h-9 w-9">
							<Pencil className="h-4 w-4" />
						</Button>
					</DialogTrigger>
				) : (
					<DropdownMenuItem
						className="w-full cursor-pointer "
						onSelect={(e) => {
							e.preventDefault();
							setIsOpen(true);
						}}
					>
						Edit Server
					</DropdownMenuItem>
				)
			) : (
				<DialogTrigger asChild>
					<Button className="cursor-pointer space-x-3">
						<PlusIcon className="h-4 w-4" />
						Create Server
					</Button>
				</DialogTrigger>
			)}
			<DialogContent className="sm:max-w-3xl ">
				<DialogHeader>
					<DialogTitle>{serverId ? "Edit" : "Create"} Server</DialogTitle>
					<DialogDescription>
						{serverId ? "Edit" : "Create"} a server to deploy your applications
						remotely.
					</DialogDescription>
				</DialogHeader>
				{!canCreateMoreServers && (
					<AlertBlock type="warning" className="mt-4">
						You cannot create more servers,{" "}
						<Link href="/dashboard/settings/billing" className="text-primary">
							Please upgrade your plan
						</Link>
					</AlertBlock>
				)}
				{isError && <AlertBlock type="error">{error?.message}</AlertBlock>}
				<Form {...form}>
					<form
						id="hook-form-add-server"
						onSubmit={form.handleSubmit(onSubmit)}
						className="grid w-full gap-4"
					>
						<div className="flex flex-col gap-4 ">
							<FormField
								control={form.control}
								name="name"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Name</FormLabel>
										<FormControl>
											<Input placeholder="Hostinger Server" {...field} />
										</FormControl>

										<FormMessage />
									</FormItem>
								)}
							/>
						</div>
						<FormField
							control={form.control}
							name="description"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Description</FormLabel>
									<FormControl>
										<Textarea
											placeholder="This server is for databases..."
											className="resize-none"
											{...field}
										/>
									</FormControl>

									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="serverType"
							render={({ field }) => {
								const serverTypeValue = form.watch("serverType");
								return (
									<FormItem>
										<FormLabel className="flex items-center gap-1.5">
											Server Type
											<TooltipProvider delayDuration={150}>
												<Tooltip>
													<TooltipTrigger asChild>
														<button
															type="button"
															aria-label="About server types"
														>
															<CircleHelp className="size-3.5 text-muted-foreground" />
														</button>
													</TooltipTrigger>
													<TooltipContent className="max-w-72">
														Deploy servers run workloads. Build servers only
														compile images and are not deployment targets.
													</TooltipContent>
												</Tooltip>
											</TooltipProvider>
										</FormLabel>
										<Select
											onValueChange={field.onChange}
											defaultValue={field.value}
										>
											<SelectTrigger>
												<SelectValue placeholder="Select a server type" />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="deploy">Deploy Server</SelectItem>
												<SelectItem value="build">Build Server</SelectItem>
											</SelectContent>
										</Select>
										<FormMessage />
										<FormDescription>
											{serverTypeValue === "deploy"
												? "Runs deployed services."
												: "Builds images without hosting workloads."}
										</FormDescription>
									</FormItem>
								);
							}}
						/>
						<FormField
							control={form.control}
							name="sshKeyId"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Select a SSH Key</FormLabel>
									<Select
										onValueChange={field.onChange}
										defaultValue={field.value}
									>
										<SelectTrigger>
											<SelectValue placeholder="Select a SSH Key" />
										</SelectTrigger>
										<SelectContent>
											{sshKeys?.map((sshKey) => (
												<SelectItem
													key={sshKey.sshKeyId}
													value={sshKey.sshKeyId}
												>
													{sshKey.name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									<FormMessage />
								</FormItem>
							)}
						/>
						<div className="grid grid-cols-2 gap-4">
							<FormField
								control={form.control}
								name="ipAddress"
								render={({ field }) => (
									<FormItem>
										<FormLabel>IP Address</FormLabel>
										<FormControl>
											<Input placeholder="192.168.1.100" {...field} />
										</FormControl>

										<FormMessage />
									</FormItem>
								)}
							/>
							<FormField
								control={form.control}
								name="port"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Port</FormLabel>
										<FormControl>
											<Input
												placeholder="22"
												{...field}
												onChange={(e) => {
													const value = e.target.value;
													if (value === "") {
														field.onChange(0);
													} else {
														const number = Number.parseInt(value, 10);
														if (!Number.isNaN(number)) {
															field.onChange(number);
														}
													}
												}}
											/>
										</FormControl>

										<FormMessage />
									</FormItem>
								)}
							/>
						</div>

						<FormField
							control={form.control}
							name="username"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Username</FormLabel>
									<FormControl>
										<Input placeholder="root" {...field} />
									</FormControl>
									<FormDescription>
										Use &quot;root&quot; or a non-root user with passwordless
										sudo access.
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="enableDockerCleanup"
							render={({ field }) => (
								<FormItem className="flex flex-row items-center justify-between rounded-lg border p-3">
									<div className="space-y-0.5">
										<FormLabel>Enable Docker Cleanup</FormLabel>
										<FormDescription>
											Automatically prune unused Docker images daily. Keeps disk
											usage in check on this remote server.
										</FormDescription>
									</div>
									<FormControl>
										<Switch
											checked={field.value}
											onCheckedChange={field.onChange}
										/>
									</FormControl>
								</FormItem>
							)}
						/>
					</form>

					<DialogFooter>
						<Button
							isLoading={isPending}
							disabled={!canCreateMoreServers && !serverId}
							form="hook-form-add-server"
							type="submit"
						>
							{serverId ? "Update" : "Create"}
						</Button>
					</DialogFooter>
				</Form>
			</DialogContent>
		</Dialog>
	);
};
