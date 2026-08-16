import { Loader2, Shield, ShieldAlert, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { AlertBlock } from "@/components/shared/alert-block";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { api } from "@/utils/api";

interface Props {
	imageRef: string;
	serverId?: string;
}

const SEVERITY_TONE: Record<string, string> = {
	CRITICAL: "bg-red-500/15 text-red-600 dark:text-red-400",
	HIGH: "bg-orange-500/15 text-orange-600 dark:text-orange-400",
	MEDIUM: "bg-amber-500/15 text-amber-700 dark:text-amber-400",
	LOW: "bg-slate-500/15 text-slate-600 dark:text-slate-400",
	UNKNOWN: "bg-slate-500/15 text-slate-600 dark:text-slate-400",
};

const ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"] as const;

export const ScanImageDialog = ({ imageRef, serverId }: Props) => {
	const [open, setOpen] = useState(false);
	const { mutateAsync, data, isPending, reset } =
		api.dockerImage.scanImage.useMutation();

	const run = async () => {
		try {
			await mutateAsync({ imageRef, serverId });
		} catch {
			// The mutation surfaces its own error state below.
		}
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (next) {
					reset();
					void run();
				}
			}}
		>
			<DialogTrigger asChild>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label="Scan for vulnerabilities"
					title="Scan for vulnerabilities"
				>
					<Shield className="size-4" />
				</Button>
			</DialogTrigger>
			<DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
				<DialogHeader>
					<DialogTitle>Vulnerability scan</DialogTitle>
					<DialogDescription className="font-mono text-xs">
						{imageRef}
					</DialogDescription>
				</DialogHeader>

				{isPending ? (
					<div className="flex min-h-[30vh] flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
						<Loader2 className="size-5 animate-spin" />
						<span>Scanning every layer…</span>
						<span className="text-xs">
							The first scan also downloads the vulnerability database.
						</span>
					</div>
				) : !data ? null : !data.scanned ? (
					<AlertBlock type="error">
						{data.error ?? "The scan did not complete."}
					</AlertBlock>
				) : data.total === 0 ? (
					<div className="flex min-h-[25vh] flex-col items-center justify-center gap-2 text-center">
						<ShieldCheck className="size-8 text-emerald-500" />
						<span className="text-base font-medium">
							No known vulnerabilities
						</span>
						<span className="text-sm text-muted-foreground">
							Nothing matched in the current database.
						</span>
					</div>
				) : (
					<div className="flex flex-col gap-4">
						<div className="flex flex-wrap items-center gap-2">
							{data.counts.CRITICAL > 0 && (
								<ShieldAlert className="size-4 text-red-500" />
							)}
							{ORDER.map((severity) =>
								data.counts[severity] > 0 ? (
									<span
										key={severity}
										className={`rounded px-2 py-0.5 font-mono text-xs ${SEVERITY_TONE[severity]}`}
									>
										{data.counts[severity]} {severity.toLowerCase()}
									</span>
								) : null,
							)}
							<span className="text-xs text-muted-foreground tabular-nums">
								{data.total} total
							</span>
						</div>

						<div className="overflow-x-auto rounded-lg border">
							<table className="w-full text-sm">
								<thead>
									<tr className="border-b bg-muted/40 text-left text-xs uppercase text-muted-foreground">
										<th className="px-3 py-2 font-medium">Severity</th>
										<th className="px-3 py-2 font-medium">CVE</th>
										<th className="px-3 py-2 font-medium">Package</th>
										<th className="px-3 py-2 font-medium">Fixed in</th>
									</tr>
								</thead>
								<tbody>
									{data.topFindings.map((finding) => (
										<tr
											key={`${finding.id}-${finding.packageName}`}
											className="border-b last:border-b-0"
										>
											<td className="px-3 py-2">
												<Badge
													variant="secondary"
													className={`text-[10px] ${SEVERITY_TONE[finding.severity]}`}
												>
													{finding.severity}
												</Badge>
											</td>
											<td className="px-3 py-2 font-mono text-xs">
												{finding.id}
											</td>
											<td className="px-3 py-2 font-mono text-xs text-muted-foreground">
												{finding.packageName}@{finding.installedVersion}
											</td>
											<td className="px-3 py-2 font-mono text-xs">
												{finding.fixedVersion ? (
													<span className="text-emerald-600 dark:text-emerald-400">
														{finding.fixedVersion}
													</span>
												) : (
													<span className="text-muted-foreground">no fix</span>
												)}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>

						{data.total > data.topFindings.length && (
							<p className="text-xs text-muted-foreground">
								Showing the {data.topFindings.length} most actionable of{" "}
								{data.total}. Issues with a known fix are listed first.
							</p>
						)}

						<div className="flex justify-end">
							<Button variant="outline" size="sm" onClick={run}>
								Re-scan
							</Button>
						</div>
					</div>
				)}
			</DialogContent>
		</Dialog>
	);
};
