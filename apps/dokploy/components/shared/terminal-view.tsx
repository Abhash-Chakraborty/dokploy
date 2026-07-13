import { RotateCcw, Server } from "lucide-react";
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
			className={
				fillHeight
					? `flex min-h-0 flex-1 flex-col gap-3 ${className ?? ""}`
					: className
			}
		>
			{showSelector && (
				<div className="flex items-center justify-between gap-2 pb-3">
					<TerminalServerSelect
						value={serverId}
						onChange={handleServerChange}
						className="w-64"
					/>
				</div>
			)}

			{isLocalServer && <LocalServerConfig onSave={reconnect} />}

			<div
				className={
					fillHeight
						? "min-h-0 flex-1 overflow-hidden rounded-xl border border-white/10 bg-[#090b0e] shadow-2xl shadow-black/20"
						: `${heightClassName} overflow-hidden rounded-xl border border-white/10 bg-[#090b0e] shadow-2xl shadow-black/20`
				}
			>
				<div className="flex h-11 items-center justify-between border-b border-white/10 bg-[#111419] px-3 text-slate-300">
					<div className="flex min-w-0 items-center gap-2 font-mono text-xs">
						<span className="flex gap-1.5" aria-hidden="true">
							<span className="size-2.5 rounded-full bg-rose-400/80" />
							<span className="size-2.5 rounded-full bg-amber-300/80" />
							<span className="size-2.5 rounded-full bg-emerald-400/80" />
						</span>
						<span className="mx-1 h-4 w-px bg-white/10" />
						<Server className="size-3.5 shrink-0" />
						<span className="truncate">
							{isLocalServer ? "dokploy-host" : serverId}
						</span>
					</div>
					<div className="flex items-center gap-2">
						<div
							className="flex items-center gap-1.5 text-[11px] font-medium capitalize"
							aria-live="polite"
						>
							<span
								className={`size-2 rounded-full ${
									connectionStatus === "connected"
										? "bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,.7)]"
										: connectionStatus === "connecting"
											? "animate-pulse bg-amber-300"
											: "bg-rose-400"
								}`}
							/>
							{connectionStatus}
						</div>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							className="size-7 text-slate-300 hover:bg-white/10 hover:text-white"
							onClick={reconnect}
							aria-label="Reconnect terminal"
							title="Reconnect terminal"
						>
							<RotateCcw className="size-3.5" />
						</Button>
					</div>
				</div>
				<Terminal
					id={terminalId}
					key={terminalKey}
					serverId={serverId}
					onStatusChange={setConnectionStatus}
				/>
			</div>
		</div>
	);
};
