import { RotateCcw } from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { api } from "@/utils/api";
import LocalServerConfig from "../dashboard/settings/web-server/local-server-config";
import type { TerminalConnectionStatus } from "../dashboard/settings/web-server/terminal";

const Terminal = dynamic(
	() =>
		import("../dashboard/settings/web-server/terminal").then((e) => e.Terminal),
	{ ssr: false },
);

const getTerminalKey = () => `terminal-${Date.now()}`;

interface TerminalServerSelectProps {
	value: string;
	onChange: (value: string) => void;
	className?: string;
}

/**
 * Reusable connected-servers + local Dokploy server picker. Exported so a page
 * can render it next to its heading (top-right) instead of stacked above the
 * terminal.
 */
export const TerminalServerSelect = ({
	value,
	onChange,
	className,
}: TerminalServerSelectProps) => {
	const { data: servers } = api.server.all.useQuery();
	return (
		<Select value={value} onValueChange={onChange}>
			<SelectTrigger className={className ?? "w-56"}>
				<SelectValue placeholder="Select a server" />
			</SelectTrigger>
			<SelectContent>
				<SelectItem value="local">Dokploy Server (local)</SelectItem>
				{servers?.map((server) => (
					<SelectItem key={server.serverId} value={server.serverId}>
						{server.name}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
};

interface TerminalViewProps {
	/** Initial server to connect to. Defaults to the local Dokploy server. */
	defaultServerId?: string;
	className?: string;
	/**
	 * Controlled server id. When provided the parent owns selection state and
	 * should also render its own <TerminalServerSelect> (set showSelector=false).
	 */
	serverId?: string;
	onServerChange?: (value: string) => void;
	/** Render the built-in selector above the terminal. Defaults to true. */
	showSelector?: boolean;
	/**
	 * Fill the parent's height and keep the scroll inside the terminal only.
	 * Use on the dedicated Terminals page. Defaults to false (legacy fixed
	 * height for embeds like the side panel).
	 */
	fillHeight?: boolean;
	/** Height of the terminal canvas when not filling height. */
	heightClassName?: string;
}

/**
 * Shared terminal surface: the xterm Terminal plus (optionally) a server
 * selector. Reused by the side panel and the dedicated Terminals page so
 * behaviour stays consistent.
 */
export const TerminalView = ({
	defaultServerId = "local",
	className,
	serverId: controlledServerId,
	onServerChange,
	showSelector = true,
	fillHeight = false,
	heightClassName = "h-[60vh]",
}: TerminalViewProps) => {
	const [internalServerId, setInternalServerId] =
		useState<string>(defaultServerId);
	const [terminalKey, setTerminalKey] = useState<string>(getTerminalKey());
	const [connectionStatus, setConnectionStatus] =
		useState<TerminalConnectionStatus>("connecting");
	const terminalId = `terminal-${useId().replaceAll(":", "")}`;

	const serverId = controlledServerId ?? internalServerId;
	const isLocalServer = serverId === "local";

	const reconnect = useCallback(() => {
		setConnectionStatus("connecting");
		setTerminalKey(getTerminalKey());
	}, []);

	const handleServerChange = (value: string) => {
		if (onServerChange) {
			onServerChange(value);
		} else {
			setInternalServerId(value);
		}
		reconnect();
	};

	return (
		<div
			className={cn(
				"flex flex-col",
				fillHeight ? "min-h-0 flex-1" : heightClassName,
				className,
			)}
		>
			<div className="flex flex-wrap items-center gap-1 pb-2">
				{showSelector && (
					<TerminalHostPicker value={serverId} onChange={handleServerChange} />
				)}
				<div className="ml-auto flex items-center gap-1">
					{isLocalServer && <LocalServerConfig onSave={reconnect} />}
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						onClick={reconnect}
						aria-label="Reconnect terminal"
						title="Reconnect"
					>
						<RotateCcw className="size-4" />
					</Button>
				</div>
			</div>
			<div className="min-h-0 flex-1 overflow-hidden rounded-lg bg-[#070708]">
				<Terminal
					id={terminalId}
					key={terminalKey}
					serverId={serverId}
					onStatusChange={setConnectionStatus}
				/>
			</div>
			<div
				className="flex items-center gap-2 pt-2 text-xs text-muted-foreground"
				aria-live="polite"
			>
				<span
					className={cn(
						"size-1.5 rounded-full",
						connectionStatus === "connected"
							? "bg-status-running"
							: connectionStatus === "connecting"
								? "animate-pulse bg-status-restarting"
								: "bg-status-failed",
					)}
				/>
				<span className="capitalize">{connectionStatus}</span>
				<span aria-hidden>·</span>
				<span className="font-mono">
					{isLocalServer ? "this server" : serverId}
				</span>
			</div>
		</div>
	);
};

/** One pill per host, so switching servers is a single click. */
export const TerminalHostPicker = ({
	value,
	onChange,
}: {
	value: string;
	onChange: (value: string) => void;
}) => {
	const { data: servers } = api.server.all.useQuery();
	const hosts = [
		{ id: "local", name: "This server", active: true },
		...(servers ?? []).map((server) => ({
			id: server.serverId,
			name: server.name,
			active: server.serverStatus === "active" && !!server.sshKeyId,
		})),
	];
	return (
		<div className="flex flex-wrap items-center gap-1" role="tablist">
			{hosts.map((host) => (
				<button
					key={host.id}
					type="button"
					role="tab"
					aria-selected={value === host.id}
					disabled={!host.active}
					onClick={() => onChange(host.id)}
					className={cn(
						"inline-flex h-8 items-center gap-2 rounded-md px-2.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50",
						value === host.id && "bg-accent text-foreground",
					)}
				>
					<span
						className={cn(
							"size-1.5 rounded-full",
							host.active ? "bg-status-running" : "bg-status-stopped",
						)}
					/>
					{host.name}
				</button>
			))}
		</div>
	);
};
