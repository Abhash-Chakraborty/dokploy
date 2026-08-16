import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { Activity, Cloud, Loader2, Play, Square, Trash2 } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { DialogAction } from "@/components/shared/dialog-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
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
import { api } from "@/utils/api";

const formSchema = z.object({
	name: z.string().trim().min(1, "Name is required"),
	token: z
		.string()
		.trim()
		.min(32, "That doesn't look like a connector token")
		.regex(/^[A-Za-z0-9+/=_-]+$/, "Token contains unexpected characters"),
	serverId: z.string(),
});

type FormValues = z.infer<typeof formSchema>;

const StatusBadge = ({ status }: { status: string }) => {
	if (status === "running") return <Badge variant="green">Connected</Badge>;
	if (status === "error") return <Badge variant="destructive">Error</Badge>;
	if (status === "stopped") return <Badge variant="secondary">Stopped</Badge>;
	return <Badge variant="secondary">Not started</Badge>;
};

const AddTunnel = ({ onDone }: { onDone: () => void }) => {
	const [open, setOpen] = useState(false);
	const { data: servers } = api.server.all.useQuery();
	const { mutateAsync, isPending } = api.cloudflareTunnel.create.useMutation();

	const form = useForm<FormValues>({
		resolver: zodResolver(formSchema),
		defaultValues: { name: "", token: "", serverId: "local" },
	});

	const onSubmit = async (values: FormValues) => {
		try {
			await mutateAsync({
				name: values.name,
				token: values.token,
				serverId: values.serverId === "local" ? null : values.serverId,
			});
			toast.success("Tunnel added. Start it to connect.");
			setOpen(false);
			form.reset();
			onDone();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Could not add the tunnel",
			);
		}
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button>Add tunnel</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Add Cloudflare Tunnel</DialogTitle>
					<DialogDescription>
						Create the tunnel in Cloudflare Zero Trust, then paste its connector
						token here. Ingress rules stay in Cloudflare; this runs the
						connector.
					</DialogDescription>
				</DialogHeader>
				<Form {...form}>
					<form
						onSubmit={form.handleSubmit(onSubmit)}
						className="flex flex-col gap-4"
						id="tunnel-form"
					>
						<FormField
							control={form.control}
							name="name"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Name</FormLabel>
									<FormControl>
										<Input placeholder="Production tunnel" {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="token"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Connector token</FormLabel>
									<FormControl>
										<Input
											type="password"
											placeholder="eyJhIjoi…"
											autoComplete="off"
											{...field}
										/>
									</FormControl>
									<FormDescription>
										Stored write-only — it can be replaced but never read back.
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="serverId"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Server</FormLabel>
									<Select onValueChange={field.onChange} value={field.value}>
										<FormControl>
											<SelectTrigger>
												<SelectValue />
											</SelectTrigger>
										</FormControl>
										<SelectContent>
											<SelectItem value="local">Dokploy host</SelectItem>
											{servers?.map((server) => (
												<SelectItem
													key={server.serverId}
													value={server.serverId}
												>
													{server.name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
									<FormMessage />
								</FormItem>
							)}
						/>
					</form>
				</Form>
				<DialogFooter>
					<Button type="submit" form="tunnel-form" isLoading={isPending}>
						Add
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};

export const ShowCloudflareTunnels = () => {
	const {
		data: tunnels,
		isPending,
		refetch,
	} = api.cloudflareTunnel.all.useQuery();
	const deploy = api.cloudflareTunnel.deploy.useMutation();
	const stop = api.cloudflareTunnel.stop.useMutation();
	const remove = api.cloudflareTunnel.remove.useMutation();
	const status = api.cloudflareTunnel.status.useMutation();

	const act = async (fn: () => Promise<unknown>, ok: string, bad: string) => {
		try {
			await fn();
			toast.success(ok);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : bad);
		}
		await refetch();
	};

	return (
		<Card className="h-full bg-sidebar p-2.5 rounded-xl w-full">
			<div className="rounded-xl bg-background shadow-md">
				<CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
					<div className="flex flex-col gap-1.5">
						<CardTitle className="text-xl flex flex-row gap-2">
							<Cloud className="size-6 text-muted-foreground self-center" />
							Cloudflare Tunnels
						</CardTitle>
						<CardDescription>
							Serve a host that has no public IP and no open inbound ports. The
							connector dials out to Cloudflare's edge.
						</CardDescription>
					</div>
					<AddTunnel onDone={() => refetch()} />
				</CardHeader>
				<CardContent className="py-6 border-t">
					{isPending ? (
						<div className="flex min-h-[20vh] flex-row items-center justify-center gap-2 text-sm text-muted-foreground">
							<span>Loading…</span>
							<Loader2 className="size-4 animate-spin" />
						</div>
					) : !tunnels || tunnels.length === 0 ? (
						<div className="flex min-h-[20vh] flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-8 text-center">
							<Cloud className="size-8 text-muted-foreground" />
							<span className="text-base font-medium">No tunnels yet</span>
							<span className="max-w-md text-sm text-muted-foreground">
								Useful for homelab and behind-NAT hosts, where opening ports
								isn't an option.
							</span>
						</div>
					) : (
						<ul className="flex flex-col gap-3">
							{tunnels.map((tunnel) => (
								<li
									key={tunnel.cloudflareTunnelId}
									className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
								>
									<div className="flex min-w-0 flex-col gap-1">
										<div className="flex flex-wrap items-center gap-2">
											<span className="font-medium">{tunnel.name}</span>
											<StatusBadge status={tunnel.status} />
										</div>
										{tunnel.statusMessage && (
											<span className="text-xs text-red-500">
												{tunnel.statusMessage}
											</span>
										)}
									</div>
									<div className="flex shrink-0 flex-wrap gap-2">
										<Button
											variant="outline"
											size="sm"
											isLoading={status.isPending}
											onClick={async () => {
												const result = await status
													.mutateAsync({
														cloudflareTunnelId: tunnel.cloudflareTunnelId,
													})
													.catch(() => null);
												if (result?.connections) {
													toast.success(result.detail);
												} else {
													toast.error(
														result?.detail ?? "Could not read the status",
													);
												}
												await refetch();
											}}
										>
											{status.isPending ? null : (
												<Activity className="size-4" />
											)}
											Check
										</Button>
										{tunnel.status === "running" ? (
											<Button
												variant="outline"
												size="sm"
												isLoading={stop.isPending}
												onClick={() =>
													act(
														() =>
															stop.mutateAsync({
																cloudflareTunnelId: tunnel.cloudflareTunnelId,
															}),
														"Connector stopped",
														"Could not stop the connector",
													)
												}
											>
												<Square className="size-4" />
												Stop
											</Button>
										) : (
											<Button
												variant="outline"
												size="sm"
												isLoading={deploy.isPending}
												onClick={() =>
													act(
														() =>
															deploy.mutateAsync({
																cloudflareTunnelId: tunnel.cloudflareTunnelId,
															}),
														"Connector started",
														"Could not start the connector",
													)
												}
											>
												<Play className="size-4" />
												Start
											</Button>
										)}
										<DialogAction
											title="Delete tunnel"
											description="This stops the connector on that host and removes the tunnel."
											type="destructive"
											onClick={() =>
												act(
													() =>
														remove.mutateAsync({
															cloudflareTunnelId: tunnel.cloudflareTunnelId,
														}),
													"Tunnel deleted",
													"Could not delete the tunnel",
												)
											}
										>
											<Button
												variant="ghost"
												size="icon"
												className="group hover:bg-red-500/10"
											>
												<Trash2 className="size-4 text-primary group-hover:text-red-500" />
											</Button>
										</DialogAction>
									</div>
								</li>
							))}
						</ul>
					)}
				</CardContent>
			</div>
		</Card>
	);
};
