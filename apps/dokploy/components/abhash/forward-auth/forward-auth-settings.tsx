import { Plus, RefreshCw, ShieldHalf, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { DialogAction } from "@/components/shared/dialog-action";
import { Badge } from "@/components/ui/badge";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { api } from "@/utils/api";

type SyncResult = { target: string; ok: boolean; error?: string };

const reportSync = (results: SyncResult[]) => {
	const failed = results.filter((r) => !r.ok);
	if (failed.length === 0) {
		toast.success(
			`Applied to ${results.length} server${results.length === 1 ? "" : "s"}`,
		);
	} else {
		toast.error(
			`Could not update ${failed.map((f) => `${f.target} (${f.error})`).join(", ")}`,
		);
	}
};

const CreateGate = () => {
	const utils = api.useUtils();
	const [open, setOpen] = useState(false);
	const [kind, setKind] = useState<"authentik" | "generic">("authentik");
	const [name, setName] = useState("Authentik");
	const [slug, setSlug] = useState("authentik");
	const [baseUrl, setBaseUrl] = useState("");
	const [address, setAddress] = useState("");
	const create = api.forwardAuth.create.useMutation();
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button variant="outline">
					<Plus className="size-4" />
					New gate
				</Button>
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>New sign-in gate</DialogTitle>
					<DialogDescription>
						For Authentik, create a Proxy provider in “Forward auth (domain
						level)” mode, add it to the embedded outpost, and enter Authentik's
						public URL here.
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-3">
					<div className="grid gap-3 sm:grid-cols-2">
						<div className="flex flex-col gap-1.5">
							<Label>Type</Label>
							<Select
								value={kind}
								onValueChange={(v) => setKind(v as typeof kind)}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="authentik">Authentik outpost</SelectItem>
									<SelectItem value="generic">
										Other forward-auth service
									</SelectItem>
								</SelectContent>
							</Select>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="gate-name">Name</Label>
							<Input
								id="gate-name"
								value={name}
								onChange={(e) => setName(e.target.value)}
							/>
						</div>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="gate-slug">Identifier</Label>
						<Input
							id="gate-slug"
							value={slug}
							onChange={(e) =>
								setSlug(
									e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
								)
							}
						/>
						<p className="text-xs text-muted-foreground">
							Becomes the Traefik middleware abhash-fa-{slug || "…"}@file.
						</p>
					</div>
					{kind === "authentik" ? (
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="gate-url">Authentik URL</Label>
							<Input
								id="gate-url"
								placeholder="https://auth.company.com"
								value={baseUrl}
								onChange={(e) => setBaseUrl(e.target.value)}
							/>
						</div>
					) : (
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="gate-address">Forward-auth address</Label>
							<Input
								id="gate-address"
								placeholder="http://oauth2-proxy:4180/oauth2/auth"
								value={address}
								onChange={(e) => setAddress(e.target.value)}
							/>
						</div>
					)}
				</div>
				<DialogFooter>
					<Button
						isLoading={create.isPending}
						disabled={!name.trim() || !slug}
						onClick={async () => {
							await create
								.mutateAsync({
									name,
									slug,
									kind,
									baseUrl: kind === "authentik" ? baseUrl : undefined,
									address: kind === "generic" ? address : undefined,
									trustForwardHeader: true,
								})
								.then(async (results) => {
									reportSync(results);
									await utils.forwardAuth.invalidate();
									setOpen(false);
								})
								.catch((error: Error) => toast.error(error.message));
						}}
					>
						Create gate
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};

export const ForwardAuthSettings = () => {
	const utils = api.useUtils();
	const { data: gates } = api.forwardAuth.list.useQuery();
	const remove = api.forwardAuth.remove.useMutation();
	const sync = api.forwardAuth.sync.useMutation();

	return (
		<section className="flex flex-col gap-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h2 className="flex items-center gap-2 text-lg font-medium">
						<ShieldHalf className="size-5 text-muted-foreground" />
						Protect apps (forward auth)
					</h2>
					<p className="max-w-2xl text-sm text-muted-foreground">
						Put any deployed app behind your identity provider: visitors sign in
						before Traefik lets them through. Choose a gate per domain under
						“Protect with SSO”.
					</p>
				</div>
				<div className="flex gap-2">
					{gates && gates.length > 0 && (
						<Button
							variant="ghost"
							isLoading={sync.isPending}
							onClick={async () => {
								await sync
									.mutateAsync()
									.then(reportSync)
									.catch((error: Error) => toast.error(error.message));
							}}
						>
							<RefreshCw className="size-4" />
							Re-apply to servers
						</Button>
					)}
					<CreateGate />
				</div>
			</div>
			{gates && gates.length > 0 && (
				<ul className="divide-y rounded-md border">
					{gates.map((g) => (
						<li key={g.id} className="flex flex-col gap-1 px-4 py-3">
							<div className="flex items-center gap-2">
								<span className="font-medium">{g.name}</span>
								<Badge variant="outline" className="capitalize">
									{g.kind}
								</Badge>
								<code className="rounded bg-muted px-1.5 py-0.5 text-xs">
									{g.middleware}
								</code>
								<DialogAction
									title={`Delete ${g.name}?`}
									description="Only possible once no domain uses it."
									type="destructive"
									onClick={async () => {
										await remove
											.mutateAsync({ id: g.id })
											.then(async (results) => {
												reportSync(results);
												await utils.forwardAuth.invalidate();
											})
											.catch((error: Error) => toast.error(error.message));
									}}
								>
									<Button
										variant="ghost"
										size="icon"
										className="ml-auto text-destructive hover:text-destructive"
										aria-label={`Delete ${g.name}`}
									>
										<Trash2 className="size-4" />
									</Button>
								</DialogAction>
							</div>
							<p className="truncate text-xs text-muted-foreground">
								{g.address}
							</p>
							<p className="text-xs text-muted-foreground">
								{g.domains.length
									? `Protects ${g.domains.join(", ")}`
									: "Not used by any domain yet"}
							</p>
						</li>
					))}
				</ul>
			)}
		</section>
	);
};
