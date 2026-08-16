import type { LucideIcon } from "lucide-react";
import { PlugZap } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

interface Props {
	title: string;
	/** The `detail` string from settings.getHostCapabilities. */
	detail?: string;
	icon?: LucideIcon;
	action?: { label: string; href: string };
}

/**
 * Shown in place of a panel whose host capability is missing — no Docker, no
 * Dokploy-managed Traefik, provisioning not finished. This is an expected
 * state, so it reads as information rather than as an error.
 */
export const CapabilityNotice = ({
	title,
	detail,
	icon: Icon = PlugZap,
	action,
}: Props) => (
	<div className="flex min-h-[35vh] w-full flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-10 text-center">
		<Icon className="size-8 text-muted-foreground" />
		<div className="flex flex-col gap-1.5">
			<span className="text-base font-medium">{title}</span>
			{detail && (
				<span className="max-w-md text-sm text-muted-foreground">{detail}</span>
			)}
		</div>
		{action && (
			<Button variant="outline" size="sm" asChild>
				<Link href={action.href}>{action.label}</Link>
			</Button>
		)}
	</div>
);
