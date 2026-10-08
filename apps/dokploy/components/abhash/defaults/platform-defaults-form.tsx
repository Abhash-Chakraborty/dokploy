import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	PageContainer,
	PageHeader,
	SectionHeader,
} from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, type RouterOutputs } from "@/utils/api";

type Defaults = RouterOutputs["platformDefaults"]["get"];

const DATABASES: [keyof Defaults["databaseImages"], string][] = [
	["postgres", "PostgreSQL"],
	["mysql", "MySQL"],
	["mariadb", "MariaDB"],
	["mongo", "MongoDB"],
	["redis", "Redis"],
	["libsql", "libSQL"],
];

const REFRESH: [keyof Defaults["refresh"], string, string][] = [
	[
		"liveStatusSeconds",
		"Service status",
		"Running, crashed or stopped badges on lists and service pages.",
	],
	["listsSeconds", "Lists", "Deployments, backups and the home page."],
	["logsSeconds", "Live views", "Container pickers and request logs."],
];

const Field = ({
	id,
	label,
	hint,
	children,
}: {
	id: string;
	label: string;
	hint?: string;
	children: React.ReactNode;
}) => (
	<div className="grid gap-1.5 sm:grid-cols-[14rem_1fr] sm:items-center sm:gap-6">
		<div>
			<Label htmlFor={id}>{label}</Label>
			{hint && <p className="text-xs text-muted-foreground">{hint}</p>}
		</div>
		{children}
	</div>
);

export const PlatformDefaultsForm = () => {
	const utils = api.useUtils();
	const { data } = api.platformDefaults.get.useQuery();
	const save = api.platformDefaults.save.useMutation();
	const [draft, setDraft] = useState<Defaults | null>(null);

	useEffect(() => {
		if (data) setDraft(data);
	}, [data]);

	if (!draft) {
		return (
			<PageContainer>
				<PageHeader title="Defaults" description="Loading…" />
			</PageContainer>
		);
	}

	const dirty = JSON.stringify(draft) !== JSON.stringify(data);
	const number = (value: string) => Number.parseInt(value, 10) || 0;

	return (
		<PageContainer>
			<PageHeader
				title="Defaults"
				description="Values Dokploy uses when you don't pick one. Changing them affects new things only, never what is already running."
				actions={
					<>
						{dirty && (
							<Button variant="ghost" onClick={() => setDraft(data ?? null)}>
								Discard
							</Button>
						)}
						<Button
							disabled={!dirty}
							isLoading={save.isPending}
							onClick={async () => {
								try {
									await save.mutateAsync(draft);
									await utils.platformDefaults.get.invalidate();
									toast.success("Defaults saved");
								} catch (error) {
									toast.error(
										error instanceof Error ? error.message : "Could not save",
									);
								}
							}}
						>
							Save
						</Button>
					</>
				}
			/>

			<section className="flex flex-col gap-4">
				<SectionHeader
					title="New databases"
					description="The image a new database starts from when the image field is left empty."
				/>
				{DATABASES.map(([key, label]) => (
					<Field key={key} id={`db-${key}`} label={label}>
						<Input
							id={`db-${key}`}
							className="font-mono text-xs"
							value={draft.databaseImages[key]}
							onChange={(event) =>
								setDraft({
									...draft,
									databaseImages: {
										...draft.databaseImages,
										[key]: event.target.value,
									},
								})
							}
						/>
					</Field>
				))}
			</section>

			<section className="flex flex-col gap-4 border-t pt-8">
				<SectionHeader
					title="Host images"
					description="Images Dokploy runs on your servers for its own jobs."
				/>
				<Field
					id="helper-image"
					label="Helper"
					hint="Reads volumes and folders for backups."
				>
					<Input
						id="helper-image"
						className="font-mono text-xs"
						value={draft.helperImage}
						onChange={(event) =>
							setDraft({ ...draft, helperImage: event.target.value })
						}
					/>
				</Field>
				<Field
					id="traefik-image"
					label="Traefik"
					hint="Only for a server that has no Traefik yet. A recreate keeps the running version."
				>
					<Input
						id="traefik-image"
						className="font-mono text-xs"
						placeholder="Dokploy's tested version"
						value={draft.traefikImage ?? ""}
						onChange={(event) =>
							setDraft({
								...draft,
								traefikImage: event.target.value || undefined,
							})
						}
					/>
				</Field>
			</section>

			<section className="flex flex-col gap-4 border-t pt-8">
				<SectionHeader
					title="Refresh rates"
					description="How often open pages ask the server for fresh data. Lower is snappier; higher is lighter on a small server."
				/>
				{REFRESH.map(([key, label, hint]) => (
					<Field key={key} id={`refresh-${key}`} label={label} hint={hint}>
						<div className="flex items-center gap-2 [&>div]:w-24">
							<Input
								id={`refresh-${key}`}
								type="number"
								min={1}
								className="w-24 tabular-nums"
								value={draft.refresh[key]}
								onChange={(event) =>
									setDraft({
										...draft,
										refresh: {
											...draft.refresh,
											[key]: number(event.target.value),
										},
									})
								}
							/>
							<span className="text-[13px] text-muted-foreground">seconds</span>
						</div>
					</Field>
				))}
				<Field
					id="probe-timeout"
					label="Server probe timeout"
					hint="How long the Servers page waits for a server before calling it unreachable."
				>
					<div className="flex items-center gap-2 [&>div]:w-24">
						<Input
							id="probe-timeout"
							type="number"
							min={3}
							className="w-24 tabular-nums"
							value={draft.fleetProbeTimeoutSeconds}
							onChange={(event) =>
								setDraft({
									...draft,
									fleetProbeTimeoutSeconds: number(event.target.value),
								})
							}
						/>
						<span className="text-[13px] text-muted-foreground">seconds</span>
					</div>
				</Field>
			</section>
		</PageContainer>
	);
};
