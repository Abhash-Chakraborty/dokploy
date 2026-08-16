import type { LogDrainConfig } from "@dokploy/server/db/schema";
import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import {
	CircleCheck,
	Loader2,
	Play,
	Square,
	Trash2,
	Waypoints,
} from "lucide-react";
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

const DRAIN_LABELS: Record<string, string> = {
	loki: "Grafana Loki",
	datadog: "Datadog",
	http: "HTTP endpoint",
};

const formSchema = z
	.object({
		name: z.string().trim().min(1, "Name is required"),
		drainType: z.enum(["loki", "datadog", "http"]),
		serverId: z.string(),
		endpoint: z.string().trim().min(1, "Endpoint is required"),
		username: z.string().optional(),
		password: z.string().optional(),
		apiKey: z.string().optional(),
		site: z.string().optional(),
		tags: z.string().optional(),
		authHeader: z.string().optional(),
	})
	.superRefine((data, ctx) => {
		if (!/^https?:\/\//i.test(data.endpoint)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["endpoint"],
				message: "Must start with http:// or https://",
			});
		}
		if (data.drainType === "datadog" && !data.apiKey?.trim()) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["apiKey"],
				message: "Datadog needs an API key",
			});
		}
	});

type FormValues = z.infer<typeof formSchema>;

const StatusBadge = ({ status }: { status: string }) => {
	if (status === "running") return <Badge variant="green">Shipping</Badge>;
	if (status === "error") return <Badge variant="destructive">Error</Badge>;
	if (status === "stopped") return <Badge variant="secondary">Stopped</Badge>;
	return <Badge variant="secondary">Not started</Badge>;
};

const AddLogDrain = ({ onDone }: { onDone: () => void }) => {
	const [open, setOpen] = useState(false);
	const { data: servers } = api.server.all.useQuery();
	const { mutateAsync, isPending } = api.logDrain.create.useMutation();

	const form = useForm<FormValues>({
		resolver: zodResolver(formSchema),
		defaultValues: {
			name: "",
			drainType: "loki",
			serverId: "local",
			endpoint: "",
			site: "datadoghq.com",
		},
	});
	const drainType = form.watch("drainType");

	const onSubmit = async (values: FormValues) => {
		// Built as an explicit discriminated value; a ternary chain here widens
		// into a union carrying every branch's keys as `undefined`.
		let config: LogDrainConfig;
		if (values.drainType === "loki") {
			config = {
				drainType: "loki",
				endpoint: values.endpoint,
				labels: {},
				...(values.username ? { username: values.username } : {}),
				...(values.password ? { password: values.password } : {}),
			};
		} else if (values.drainType === "datadog") {
			config = {
				drainType: "datadog",
				endpoint: values.endpoint,
				apiKey: values.apiKey ?? "",
				site: values.site || "datadoghq.com",
				...(values.tags ? { tags: values.tags } : {}),
			};
		} else {
			config = {
				drainType: "http",
				endpoint: values.endpoint,
				headers: values.authHeader ? { Authorization: values.authHeader } : {},
				encoding: "json",
			};
		}

		try {
			await mutateAsync({
				name: values.name,
				serverId: values.serverId === "local" ? null : values.serverId,
				enabled: true,
				config,
			});
			toast.success("Log drain created. Start it to begin shipping.");
			setOpen(false);
			form.reset();
			onDone();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Could not create the drain",
			);
		}
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button>Add log drain</Button>
			</DialogTrigger>
			<DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Add log drain</DialogTitle>
					<DialogDescription>
						Ships the logs of every container on a host to an external sink.
					</DialogDescription>
				</DialogHeader>
				<Form {...form}>
					<form
						onSubmit={form.handleSubmit(onSubmit)}
						className="flex flex-col gap-4"
						id="log-drain-form"
					>
						<FormField
							control={form.control}
							name="name"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Name</FormLabel>
									<FormControl>
										<Input placeholder="Production logs" {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="drainType"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Destination</FormLabel>
									<Select onValueChange={field.onChange} value={field.value}>
										<FormControl>
											<SelectTrigger>
												<SelectValue />
											</SelectTrigger>
										</FormControl>
										<SelectContent>
											{Object.entries(DRAIN_LABELS).map(([value, label]) => (
												<SelectItem key={value} value={value}>
													{label}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
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
									<FormDescription>
										One shipper per host — it reads every container there.
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="endpoint"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Endpoint</FormLabel>
									<FormControl>
										<Input
											placeholder={
												drainType === "loki"
													? "http://loki:3100"
													: drainType === "datadog"
														? "https://http-intake.logs.datadoghq.com"
														: "https://logs.example.com/ingest"
											}
											{...field}
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>

						{drainType === "loki" && (
							<div className="grid grid-cols-2 gap-3">
								<FormField
									control={form.control}
									name="username"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Username</FormLabel>
											<FormControl>
												<Input placeholder="Optional" {...field} />
											</FormControl>
										</FormItem>
									)}
								/>
								<FormField
									control={form.control}
									name="password"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Password</FormLabel>
											<FormControl>
												<Input
													type="password"
													placeholder="Optional"
													{...field}
												/>
											</FormControl>
										</FormItem>
									)}
								/>
							</div>
						)}

						{drainType === "datadog" && (
							<>
								<FormField
									control={form.control}
									name="apiKey"
									render={({ field }) => (
										<FormItem>
											<FormLabel>API key</FormLabel>
											<FormControl>
												<Input type="password" {...field} />
											</FormControl>
											<FormMessage />
										</FormItem>
									)}
								/>
								<div className="grid grid-cols-2 gap-3">
									<FormField
										control={form.control}
										name="site"
										render={({ field }) => (
											<FormItem>
												<FormLabel>Site</FormLabel>
												<FormControl>
													<Input placeholder="datadoghq.com" {...field} />
												</FormControl>
											</FormItem>
										)}
									/>
									<FormField
										control={form.control}
										name="tags"
										render={({ field }) => (
											<FormItem>
												<FormLabel>Tags</FormLabel>
												<FormControl>
													<Input placeholder="env:prod,team:core" {...field} />
												</FormControl>
											</FormItem>
										)}
									/>
								</div>
							</>
						)}

						{drainType === "http" && (
							<FormField
								control={form.control}
								name="authHeader"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Authorization header</FormLabel>
										<FormControl>
											<Input placeholder="Bearer …" {...field} />
										</FormControl>
										<FormDescription>
											Optional. Sent verbatim with every request.
										</FormDescription>
									</FormItem>
								)}
							/>
						)}
					</form>
				</Form>
				<DialogFooter>
					<Button type="submit" form="log-drain-form" isLoading={isPending}>
						Create
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};

export const ShowLogDrains = () => {
	const { data: drains, isPending, refetch } = api.logDrain.all.useQuery();
	const deploy = api.logDrain.deploy.useMutation();
	const stop = api.logDrain.stop.useMutation();
	const remove = api.logDrain.remove.useMutation();
	const validate = api.logDrain.validate.useMutation();

	const act = async (
		fn: () => Promise<unknown>,
		success: string,
		failure: string,
	) => {
		try {
			await fn();
			toast.success(success);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : failure);
		}
		await refetch();
	};

	return (
		<Card className="h-full bg-sidebar p-2.5 rounded-xl w-full">
			<div className="rounded-xl bg-background shadow-md">
				<CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
					<div className="flex flex-col gap-1.5">
						<CardTitle className="text-xl flex flex-row gap-2">
							<Waypoints className="size-6 text-muted-foreground self-center" />
							Log drains
						</CardTitle>
						<CardDescription>
							Ship container logs off the host to Loki, Datadog or any HTTP
							endpoint. Without one, logs live and die with the container.
						</CardDescription>
					</div>
					<AddLogDrain onDone={() => refetch()} />
				</CardHeader>
				<CardContent className="py-6 border-t">
					{isPending ? (
						<div className="flex min-h-[20vh] flex-row items-center justify-center gap-2 text-sm text-muted-foreground">
							<span>Loading…</span>
							<Loader2 className="size-4 animate-spin" />
						</div>
					) : !drains || drains.length === 0 ? (
						<div className="flex min-h-[20vh] flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-8 text-center">
							<Waypoints className="size-8 text-muted-foreground" />
							<span className="text-base font-medium">No log drains yet</span>
							<span className="max-w-md text-sm text-muted-foreground">
								Add one to forward every container's output to your logging
								stack.
							</span>
						</div>
					) : (
						<ul className="flex flex-col gap-3">
							{drains.map((drain) => (
								<li
									key={drain.logDrainId}
									className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between"
								>
									<div className="flex min-w-0 flex-col gap-1">
										<div className="flex flex-wrap items-center gap-2">
											<span className="font-medium">{drain.name}</span>
											<Badge variant="secondary" className="text-[10px]">
												{DRAIN_LABELS[drain.drainType] ?? drain.drainType}
											</Badge>
											<StatusBadge status={drain.status} />
										</div>
										<span className="truncate font-mono text-xs text-muted-foreground">
											{drain.config.endpoint}
										</span>
										{drain.statusMessage && (
											<span className="text-xs text-red-500">
												{drain.statusMessage}
											</span>
										)}
									</div>
									<div className="flex shrink-0 flex-wrap gap-2">
										<Button
											variant="outline"
											size="sm"
											isLoading={validate.isPending}
											onClick={async () => {
												const result = await validate
													.mutateAsync({ logDrainId: drain.logDrainId })
													.catch(() => null);
												if (result?.valid) {
													toast.success("Configuration is valid");
												} else {
													toast.error(
														result?.output || "Could not validate the config",
													);
												}
											}}
										>
											{validate.isPending ? null : (
												<CircleCheck className="size-4" />
											)}
											Check
										</Button>
										{drain.status === "running" ? (
											<Button
												variant="outline"
												size="sm"
												isLoading={stop.isPending}
												onClick={() =>
													act(
														() =>
															stop.mutateAsync({
																logDrainId: drain.logDrainId,
															}),
														"Stopped shipping",
														"Could not stop the shipper",
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
																logDrainId: drain.logDrainId,
															}),
														"Shipping started",
														"Could not start the shipper",
													)
												}
											>
												<Play className="size-4" />
												Start
											</Button>
										)}
										<DialogAction
											title="Delete log drain"
											description="This stops the shipper on that host and removes the drain."
											type="destructive"
											onClick={() =>
												act(
													() =>
														remove.mutateAsync({
															logDrainId: drain.logDrainId,
														}),
													"Log drain deleted",
													"Could not delete the drain",
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
