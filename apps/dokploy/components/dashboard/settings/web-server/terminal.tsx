import { Terminal as XTerm } from "@xterm/xterm";
import type React from "react";
import { useEffect, useRef } from "react";
import { FitAddon } from "xterm-addon-fit";
import "@xterm/xterm/css/xterm.css";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { getLocalServerData } from "./local-server-config";

const RESIZE_MESSAGE_PREFIX = "\u0000dokploy-resize:";

interface Props {
	id: string;
	serverId: string;
	onStatusChange?: (status: TerminalConnectionStatus) => void;
}

export type TerminalConnectionStatus =
	| "connecting"
	| "connected"
	| "disconnected"
	| "error";

export const Terminal: React.FC<Props> = ({ id, serverId, onStatusChange }) => {
	const termRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		onStatusChange?.("connecting");
		const container = termRef.current;
		if (!container) return;
		container.replaceChildren();

		const term = new XTerm({
			cursorBlink: true,
			lineHeight: 1.4,
			convertEol: true,
			fontFamily:
				'"JetBrains Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace',
			fontSize: 13,
			scrollback: 5000,
			theme: {
				cursor: "#f8fafc",
				background: "rgba(0, 0, 0, 0)",
				foreground: "#e2e8f0",
				selectionBackground: "#334155",
			},
		});

		const addonFit = new FitAddon();
		const clipboardAddon = new ClipboardAddon();
		term.loadAddon(addonFit);
		term.loadAddon(clipboardAddon);
		term.open(container);
		addonFit.fit();

		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";

		const urlParams = new URLSearchParams();
		urlParams.set("serverId", serverId);

		if (serverId === "local") {
			const { port, username } = getLocalServerData();
			urlParams.set("port", port.toString());
			urlParams.set("username", username);
		}
		urlParams.set("cols", String(term.cols));
		urlParams.set("rows", String(term.rows));

		const wsUrl = `${protocol}//${window.location.host}/terminal?${urlParams}`;

		const ws = new WebSocket(wsUrl);
		ws.binaryType = "arraybuffer";
		ws.addEventListener("open", () => onStatusChange?.("connected"));

		const inputDisposable = term.onData((data) => {
			if (ws.readyState === WebSocket.OPEN) ws.send(data);
		});
		const resizeDisposable = term.onResize(({ cols, rows }) => {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(`${RESIZE_MESSAGE_PREFIX}${JSON.stringify({ cols, rows })}`);
			}
		});

		ws.addEventListener("message", async (event) => {
			if (typeof event.data === "string") {
				term.write(event.data);
				return;
			}
			if (event.data instanceof ArrayBuffer) {
				term.write(new Uint8Array(event.data));
				return;
			}
			if (event.data instanceof Blob) {
				term.write(new Uint8Array(await event.data.arrayBuffer()));
			}
		});
		ws.addEventListener("close", (event) => {
			onStatusChange?.(event.code === 1000 ? "disconnected" : "error");
			if (event.code !== 1000) {
				term.writeln(
					`\r\n[connection closed${event.reason ? `: ${event.reason}` : ""}]`,
				);
			}
		});
		ws.addEventListener("error", () => {
			onStatusChange?.("error");
			term.writeln("\r\n[terminal connection error]");
		});

		const resizeObserver = new ResizeObserver(() => {
			if (container.clientWidth > 0 && container.clientHeight > 0)
				addonFit.fit();
		});
		resizeObserver.observe(container);

		return () => {
			resizeObserver.disconnect();
			inputDisposable.dispose();
			resizeDisposable.dispose();
			if (
				ws.readyState === WebSocket.OPEN ||
				ws.readyState === WebSocket.CONNECTING
			) {
				ws.close(1000, "Terminal switched or closed");
			}
			term.dispose();
		};
	}, [id, onStatusChange, serverId]);

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="h-full w-full rounded-b-xl bg-[#090b0e] p-3 shadow-inner">
				<div id={id} ref={termRef} className="h-full min-h-64 rounded-xl" />
			</div>
		</div>
	);
};
