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

interface TerminalViewProps {
	/** Initial server to connect to. Defaults to the local Dokploy server. */
	defaultServerId?: string;
	className?: string;
	/** Height of the terminal canvas. Defaults to a tall fixed height. */
	heightClassName?: string;
}

/**
 * Shared terminal surface: a server selector (all connected servers + the
 * local Dokploy server) on top of the xterm Terminal. Reused by the side
 * panel and the dedicated Terminals page so behaviour stays consistent.
 */
export const TerminalView = ({
	defaultServerId = "local",
	className,
	heightClassName = "h-[60vh]",
}: TerminalViewProps) => {
	const { data: servers } = api.server.all.useQuery();
	const [serverId, setServerId] = useState<string>(defaultServerId);
	const [terminalKey, setTerminalKey] = useState<string>(getTerminalKey());

	const isLocalServer = serverId === "local";

	const reconnect = () => setTerminalKey(getTerminalKey());

	const handleServerChange = (value: string) => {
		setServerId(value);
		reconnect();
	};

	return (
		<div className={className}>
			<div className="flex items-center justify-between gap-2 pb-3">
				<Select value={serverId} onValueChange={handleServerChange}>
					<SelectTrigger className="w-64">
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
			</div>

			{isLocalServer && <LocalServerConfig onSave={reconnect} />}

			<div className={heightClassName}>
				<Terminal id="shared-terminal" key={terminalKey} serverId={serverId} />
			</div>
		</div>
	);
};
