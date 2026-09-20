import { Check, Copy, RefreshCw, Trash2, Workflow } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { DialogAction } from "@/components/shared/dialog-action";
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
import { Switch } from "@/components/ui/switch";
import { api } from "@/utils/api";

const Copyable = ({ value }: { value: string }) => {
	const [copied, setCopied] = useState(false);
	return (
		<div className="flex items-center gap-2 rounded-md border bg-muted/40 px-2 py-1.5">
			<code className="flex-1 break-all text-xs">{value}</code>
			<Button
				type="button"
				variant="ghost"
				size="icon"
				className="size-6 shrink-0"
				aria-label="Copy"
				onClick={async () => {
					await navigator.clipboard.writeText(value);
					setCopied(true);
					setTimeout(() => setCopied(false), 1500);
				}}
			>
				{copied ? <Check className="size-3" /> : <Copy className="size-3" />}
			</Button>
		</div>
	);
};

const TokenDialog = ({
	providerId,
	children,
}: {
	providerId?: string;
	children: React.ReactNode;
}) => {
	const utils = api.useUtils();
	const [open, setOpen] = useState(false);
	const [name, setName] = useState(providerId ?? "authentik-scim");
	const [token, setToken] = useState<string | null>(null);
	const create = api.abhashScim.createToken.useMutation();
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) setToken(null);
			}}
		>
			<DialogTrigger asChild>{children}</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						{providerId ? "Rotate token" : "New SCIM connection"}
					</DialogTitle>
					<DialogDescription>
						{providerId
							? "The current token stops working immediately."
							: "Paste the token into your identity provider's SCIM settings."}
					</DialogDescription>
				</DialogHeader>
				{token ? (
					<div className="flex flex-col gap-2">
						<Label>Token (shown once)</Label>
						<Copyable value={token} />
					</div>
				) : (
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="scim-name">Connection name</Label>
						<Input
							id="scim-name"
							disabled={!!providerId}
							value={name}
							onChange={(e) =>
								setName(
									e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
								)
							}
						/>
					</div>
				)}
				<DialogFooter>
					{token ? (
						<Button onClick={() => setOpen(false)}>Done</Button>
					) : (
						<Button
							isLoading={create.isPending}
							onClick={async () => {
								await create
									.mutateAsync({ providerId: name })
									.then(async (r) => {
										setToken(r.token);
										await utils.abhashScim.invalidate();
									})
									.catch((error: Error) => toast.error(error.message));
							}}
						>
							{providerId ? "Rotate" : "Create token"}
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};

export const ScimSettings = () => {
	const utils = api.useUtils();
	const { data: me } = api.user.get.useQuery();
	const { data } = api.abhashScim.status.useQuery();
	const setEnabled = api.abhashScim.setEnabled.useMutation();
	const revoke = api.abhashScim.revoke.useMutation();
	const origin = typeof window === "undefined" ? "" : window.location.origin;

	return (
		<section className="flex flex-col gap-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h2 className="flex items-center gap-2 text-lg font-medium">
						<Workflow className="size-5 text-muted-foreground" />
						Provisioning (SCIM)
					</h2>
					<p className="max-w-2xl text-sm text-muted-foreground">
						Authentik creates people, syncs groups as teams and suspends anyone
						it deactivates. Pair it with single sign-on.
					</p>
				</div>
				<div className="flex items-center gap-3">
					{me?.role === "owner" && data && (
						<div className="flex items-center gap-2">
							<Label htmlFor="scim-on">SCIM</Label>
							<Switch
								id="scim-on"
								checked={data.enabled}
								onCheckedChange={async (enabled) => {
									await setEnabled
										.mutateAsync({ enabled })
										.then(() => utils.abhashScim.invalidate())
										.catch((error: Error) => toast.error(error.message));
								}}
							/>
						</div>
					)}
					<TokenDialog>
						<Button variant="outline">New connection</Button>
					</TokenDialog>
				</div>
			</div>
			<div className="flex flex-col gap-1.5">
				<Label>SCIM base URL</Label>
				<Copyable value={`${origin}/api/auth/scim/v2`} />
			</div>
			{data && data.connections.length > 0 && (
				<ul className="divide-y rounded-md border">
					{data.connections.map((c) => (
						<li
							key={c.providerId}
							className="flex items-center gap-3 px-3 py-2"
						>
							<span className="flex-1 text-sm">{c.providerId}</span>
							<TokenDialog providerId={c.providerId}>
								<Button variant="ghost" size="icon" aria-label="Rotate token">
									<RefreshCw className="size-4" />
								</Button>
							</TokenDialog>
							<DialogAction
								title={`Revoke ${c.providerId}?`}
								description="The identity provider can no longer provision users or groups."
								type="destructive"
								onClick={async () => {
									await revoke
										.mutateAsync({ providerId: c.providerId })
										.then(() => utils.abhashScim.invalidate())
										.catch((error: Error) => toast.error(error.message));
								}}
							>
								<Button
									variant="ghost"
									size="icon"
									aria-label="Revoke"
									className="text-destructive hover:text-destructive"
								>
									<Trash2 className="size-4" />
								</Button>
							</DialogAction>
						</li>
					))}
				</ul>
			)}
		</section>
	);
};
