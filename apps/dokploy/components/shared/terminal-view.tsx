import dynamic from "next/dynamic";
import { useState } from "react";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { api } from "@/utils/api";
import LocalServerConfig from "../dashboard/settings/web-server/local-server-config";

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

	const serverId = controlledServerId ?? internalServerId;
	const isLocalServer = serverId === "local";

	const reconnect = () => setTerminalKey(getTerminalKey());

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
					fillHeight ? "min-h-0 flex-1 overflow-hidden" : heightClassName
				}
			>
				<Terminal id="shared-terminal" key={terminalKey} serverId={serverId} />
			</div>
		</div>
	);
};
