import { applySpread, readSpread } from "@dokploy/server/utils/cluster/spread";
import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { Server } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { InfoTooltip } from "@/components/shared/info-tooltip";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api } from "@/utils/api";
import { AddSwarmSettings } from "./modify-swarm-settings";

interface Props {
	id: string;
	type: "application" | "mariadb" | "mongo" | "mysql" | "postgres" | "redis";
}

const AddRedirectSchema = z.object({
	replicas: z.number().min(1, "Replicas must be at least 1"),
	registryId: z.string().optional(),
	spread: z.boolean(),
	maxPerNode: z.number().int().min(0),
});

type AddCommand = z.infer<typeof AddRedirectSchema>;

export const ShowClusterSettings = ({ id, type }: Props) => {
	const queryMap = {
		application: () =>
			api.application.one.useQuery({ applicationId: id }, { enabled: !!id }),
		mariadb: () =>
			api.mariadb.one.useQuery({ mariadbId: id }, { enabled: !!id }),
		mongo: () => api.mongo.one.useQuery({ mongoId: id }, { enabled: !!id }),
		mysql: () => api.mysql.one.useQuery({ mysqlId: id }, { enabled: !!id }),
		postgres: () =>
			api.postgres.one.useQuery({ postgresId: id }, { enabled: !!id }),
		redis: () => api.redis.one.useQuery({ redisId: id }, { enabled: !!id }),
	};
	const { data, refetch } = queryMap[type]
		? queryMap[type]()
		: api.mongo.one.useQuery({ mongoId: id }, { enabled: !!id });
	const { data: registries } = api.registry.all.useQuery();
	const { data: nodes } = api.swarm.getNodes.useQuery(
		{ serverId: data?.serverId ?? undefined },
		{ enabled: !!data },
	);
	const hasMounts =
		data && "mounts" in data && Array.isArray(data.mounts)
			? data.mounts.length > 0
			: false;

	const formValues = (): AddCommand => ({
		...(type === "application" && data && "registryId" in data
			? { registryId: data?.registryId || "" }
			: {}),
		replicas: data?.replicas || 1,
		...readSpread(data?.placementSwarm),
	});

	const mutationMap = {
		application: () => api.application.update.useMutation(),
		libsql: () => api.libsql.update.useMutation(),
		mariadb: () => api.mariadb.update.useMutation(),
		mongo: () => api.mongo.update.useMutation(),
		mysql: () => api.mysql.update.useMutation(),
		postgres: () => api.postgres.update.useMutation(),
		redis: () => api.redis.update.useMutation(),
	};

	const { mutateAsync, isPending } = mutationMap[type]
		? mutationMap[type]()
		: api.mongo.update.useMutation();

	const form = useForm<AddCommand>({
		defaultValues: formValues(),
		resolver: zodResolver(AddRedirectSchema),
	});

	// Keyed on the loaded row, not on `command`: a service with no custom
	// command never filled the form with its saved replicas.
	useEffect(() => {
		if (data) form.reset(formValues());
	}, [data]);

	const current = data;
	const onSubmit = async (data: AddCommand) => {
		await mutateAsync({
			applicationId: id || "",
			mariadbId: id || "",
			mongoId: id || "",
			mysqlId: id || "",
			postgresId: id || "",
			redisId: id || "",
			...(type === "application"
				? {
						registryId:
							data?.registryId === "none" || !data?.registryId
								? null
								: data?.registryId,
					}
				: {}),
			replicas: data?.replicas,
			placementSwarm: applySpread(
				current?.placementSwarm,
				{ spread: data.spread, maxPerNode: data.maxPerNode },
				hasMounts,
			),
		})
			.then(async () => {
				toast.success("Cluster settings saved");
				await refetch();
			})
			.catch(() => {
				toast.error("Could not save the cluster settings");
			});
	};

	return (
		<Card className="bg-background">
			<CardHeader className="flex flex-row justify-between">
				<div>
					<CardTitle className="flex items-center gap-2 text-xl">
						Cluster Settings
						<InfoTooltip content="Redeploy after changing the cluster settings to apply them." />
					</CardTitle>
					<CardDescription>
						Modify swarm settings for the service.
					</CardDescription>
				</div>
				<AddSwarmSettings id={id} type={type} />
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				<Form {...form}>
					<form
						onSubmit={form.handleSubmit(onSubmit)}
						className="grid w-full gap-4"
					>
						<div className="flex flex-col gap-4">
							<FormField
								control={form.control}
								name="replicas"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Replicas</FormLabel>
										<FormControl>
											<Input
												placeholder="1"
												{...field}
												onChange={(e) => {
													const value = e.target.value;
													field.onChange(value === "" ? 0 : Number(value));
												}}
												type="number"
												value={field.value || ""}
											/>
										</FormControl>

										<FormMessage />
									</FormItem>
								)}
							/>
							<div className="flex flex-wrap items-end gap-4 rounded-lg border px-4 py-3">
								<FormField
									control={form.control}
									name="spread"
									render={({ field }) => (
										<FormItem className="flex min-w-0 flex-1 items-center justify-between gap-4">
											<div className="space-y-0.5">
												<FormLabel className="flex items-center gap-2">
													Spread across nodes
													<InfoTooltip
														content={
															<span>
																Places replicas evenly over the nodes of this
																server's swarm, so losing one node keeps the
																rest serving. Traffic is balanced across them by
																the swarm routing mesh. Add nodes under Docker,
																Swarm, Nodes. Separate remote servers are
																separate swarms and do not share replicas.
															</span>
														}
													/>
												</FormLabel>
												<p className="text-xs text-muted-foreground">
													{nodes
														? `${nodes.length} node${nodes.length === 1 ? "" : "s"} in this swarm`
														: "Checking the swarm..."}
													{hasMounts &&
														" · has volumes, so it stays on manager nodes unless you change the constraints"}
												</p>
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
								<FormField
									control={form.control}
									name="maxPerNode"
									render={({ field }) => (
										<FormItem className="w-32">
											<FormLabel className="text-xs text-muted-foreground">
												Max per node
											</FormLabel>
											<FormControl>
												<Input
													type="number"
													min={0}
													placeholder="No limit"
													className="h-8"
													value={field.value || ""}
													onChange={(e) =>
														field.onChange(
															e.target.value === ""
																? 0
																: Number(e.target.value),
														)
													}
												/>
											</FormControl>
										</FormItem>
									)}
								/>
							</div>
						</div>

						{type === "application" && (
							<>
								{registries && registries?.length === 0 ? (
									<div className="pt-10">
										<div className="flex flex-col items-center gap-3">
											<Server className="size-8 text-muted-foreground" />
											<span className="text-base text-muted-foreground">
												To use a cluster feature, you need to configure at least
												a registry first. Please, go to{" "}
												<Link
													href="/dashboard/docker?tab=swarm&subtab=nodes"
													className="text-foreground"
												>
													Settings
												</Link>{" "}
												to do so.
											</span>
										</div>
									</div>
								) : (
									<>
										<FormField
											control={form.control}
											name="registryId"
											render={({ field }) => (
												<FormItem>
													<FormLabel>Select a registry</FormLabel>
													<Select
														onValueChange={field.onChange}
														defaultValue={field.value}
													>
														<SelectTrigger>
															<SelectValue placeholder="Select a registry" />
														</SelectTrigger>
														<SelectContent>
															<SelectGroup>
																{registries?.map((registry) => (
																	<SelectItem
																		key={registry.registryId}
																		value={registry.registryId}
																	>
																		{registry.registryName}
																	</SelectItem>
																))}
																<SelectItem value={"none"}>None</SelectItem>
																<SelectLabel>
																	Registries ({registries?.length})
																</SelectLabel>
															</SelectGroup>
														</SelectContent>
													</Select>
												</FormItem>
											)}
										/>
									</>
								)}
							</>
						)}

						<div className="flex justify-end">
							<Button isLoading={isPending} type="submit" className="w-fit">
								Save
							</Button>
						</div>
					</form>
				</Form>
			</CardContent>
		</Card>
	);
};
