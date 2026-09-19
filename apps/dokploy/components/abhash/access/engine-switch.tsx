import { Sparkles } from "lucide-react";
import { toast } from "sonner";
import { DialogAction } from "@/components/shared/dialog-action";
import { Button } from "@/components/ui/button";
import { api } from "@/utils/api";

/** Owner-only switch for the per-project access engine. */
export const EngineSwitch = () => {
	const utils = api.useUtils();
	const { data: me } = api.user.get.useQuery();
	const { data: status } = api.access.status.useQuery();
	const setEnabled = api.access.setEnabled.useMutation();
	if (me?.role !== "owner" || !status) return null;

	const toggle = async (enabled: boolean) => {
		await setEnabled
			.mutateAsync({ enabled })
			.then(async (r) => {
				await utils.invalidate();
				toast.success(
					enabled
						? `Per-project access is on (${r.mirroredMembers} members carried over unchanged)`
						: "Per-project access is off; the legacy permissions apply again",
				);
			})
			.catch((error: Error) => toast.error(error.message));
	};

	return status.rbacV2 ? (
		<div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm">
			<span className="text-muted-foreground">
				Per-project access and teams are on.
			</span>
			<DialogAction
				title="Turn off per-project access?"
				description="The legacy per-member permissions apply again. Teams and grants are kept and return when you turn it back on."
				type="destructive"
				onClick={() => toggle(false)}
			>
				<Button variant="ghost" size="sm" isLoading={setEnabled.isPending}>
					Turn off
				</Button>
			</DialogAction>
		</div>
	) : (
		<div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/30 bg-primary/5 px-4 py-3">
			<div className="flex items-start gap-3">
				<Sparkles className="mt-0.5 size-5 text-primary" />
				<div>
					<p className="text-sm font-medium">Per-project access and teams</p>
					<p className="text-sm text-muted-foreground">
						Give people and teams a role on specific projects. Current access
						carries over exactly; nobody gains or loses anything.
					</p>
				</div>
			</div>
			<DialogAction
				title="Turn on per-project access?"
				description="Every member keeps exactly the access they have today. You can then grant roles per project and use teams. You can turn it off again at any time."
				onClick={() => toggle(true)}
			>
				<Button isLoading={setEnabled.isPending}>Turn on</Button>
			</DialogAction>
		</div>
	);
};
