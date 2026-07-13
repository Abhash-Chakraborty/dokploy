import { cn } from "@/lib/utils";
import { api } from "@/utils/api";

/**
 * Thin, edge-to-edge footer rendered once inside the dashboard shell so every
 * page shows the running application version. Kept minimal ("V 0.x") to
 * conserve vertical space.
 */
export const VersionFooter = ({ className }: { className?: string }) => {
	const { data: dokployVersion } = api.settings.getDokployVersion.useQuery();

	if (!dokployVersion) return null;

	const version = String(dokployVersion).replace(/^v/i, "");

	return (
		<footer
			className={cn(
				"mt-auto flex h-8 shrink-0 items-center justify-end border-t border-border bg-background px-4 text-xs text-muted-foreground",
				className,
			)}
		>
			<span className="font-mono">V {version}</span>
		</footer>
	);
};
