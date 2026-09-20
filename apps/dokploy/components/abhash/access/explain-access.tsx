import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { api } from "@/utils/api";

/** Shows what a member can do on a chosen project, environment or service, and why. */
export const ExplainAccess = ({ userId }: { userId: string }) => {
	const { data: scopes } = api.access.scopes.useQuery();
	const [target, setTarget] = useState("");
	const [scopeType, scopeId] = target.split(":") as [
		"project" | "environment" | "service",
		string,
	];
	const { data, isFetching } = api.access.explain.useQuery(
		{ userId, scopeType, scopeId },
		{ enabled: !!scopeId },
	);

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-col gap-1.5">
				<Label>Check effective access on</Label>
				<Select value={target} onValueChange={setTarget}>
					<SelectTrigger>
						<SelectValue placeholder="Choose a project, environment or service" />
					</SelectTrigger>
					<SelectContent>
						{scopes?.projects.map((p) => (
							<SelectGroup key={p.id}>
								<SelectLabel>{p.name}</SelectLabel>
								<SelectItem value={`project:${p.id}`}>Whole project</SelectItem>
								{p.environments.map((e) => (
									<div key={e.id}>
										<SelectItem value={`environment:${e.id}`}>
											{e.name}
										</SelectItem>
										{e.services.map((s) => (
											<SelectItem key={s.id} value={`service:${s.id}`}>
												<span className="pl-4">
													{e.name} / {s.name}
												</span>
											</SelectItem>
										))}
									</div>
								))}
							</SelectGroup>
						))}
					</SelectContent>
				</Select>
			</div>

			{scopeId && (
				<div className="rounded-md border">
					{isFetching ? (
						<p className="p-3 text-sm text-muted-foreground">Checking…</p>
					) : !data ? (
						<p className="p-3 text-sm text-muted-foreground">Not a member.</p>
					) : data.privileged ? (
						<p className="p-3 text-sm">
							As organization <strong>{data.role}</strong>, this member can do
							everything here.
						</p>
					) : Object.keys(data.grants).length === 0 ? (
						<p className="p-3 text-sm">No access here.</p>
					) : (
						<ul className="divide-y">
							{Object.entries(data.grants).map(([resource, actions]) => (
								<li key={resource} className="flex flex-col gap-1 px-3 py-2">
									<span className="text-sm font-medium">{resource}</span>
									<div className="flex flex-wrap gap-1">
										{actions.map((a) => (
											<Badge
												key={a.action}
												variant="outline"
												title={a.via.join("\n")}
											>
												{a.action}
											</Badge>
										))}
									</div>
								</li>
							))}
						</ul>
					)}
				</div>
			)}
		</div>
	);
};
