import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import type React from "react";
import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { fixMacOsAltKeys } from "@/lib/terminal-keyboard";

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

		// The app's own mono font is loaded by next/font, so its metrics are
		// known when xterm measures a cell; the old "JetBrains Mono" first choice
		// was never loaded and the fallback's widths clipped wide glyphs such as
		// the zsh arrow.
		const appMono = getComputedStyle(document.documentElement)
			.getPropertyValue("--font-geist-mono")
			.trim();
		const term = new XTerm({
			cursorBlink: true,
			lineHeight: 1.25,
			// The server side is a real PTY that already sends \r\n; converting
			// again moved the cursor and broke zsh's prompt redraws.
			convertEol: false,
			rescaleOverlappingGlyphs: true,
			fontFamily: [appMono, "ui-monospace", "Menlo", "Consolas", "monospace"]
				.filter(Boolean)
				.join(", "),
			fontSize: 13,
			scrollback: 5000,
			theme: {
				cursor: "#f8fafc",
				background: "#070708",
				foreground: "#e2e8f0",
				selectionBackground: "#334155",
			},
		});

		const addonFit = new FitAddon();
		const clipboardAddon = new ClipboardAddon();
		term.loadAddon(addonFit);
		term.loadAddon(clipboardAddon);
		fixMacOsAltKeys(term);
		term.open(container);

		// The terminal lives inside a flex column that can measure 0x0 on the
		// first paint. Fitting then leaves xterm's renderer without dimensions,
		// and its viewport later throws when it syncs the scroll area. Only fit
		// once the container has a real size, and never after dispose.
		let disposed = false;
		const safeFit = () => {
			if (disposed) return;
			if (container.clientWidth <= 0 || container.clientHeight <= 0) return;
			try {
				addonFit.fit();
			} catch {
				// Renderer not ready yet; the ResizeObserver retries on next layout.
			}
		};
		const safeWrite = (data: string | Uint8Array) => {
			if (disposed) return;
			term.write(data);
		};
		const safeWriteln = (line: string) => {
			if (disposed) return;
			term.writeln(line);
		};

		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";

		// Measure before connecting: the server starts the shell at the size
		// it is given, and a later resize sent before the socket opened was
		// dropped, which left the shell at 80 columns in a wide window (zsh's
		// right-hand clock then sat mid-screen).
		safeFit();

		const urlParams = new URLSearchParams();
		urlParams.set("serverId", serverId);
		urlParams.set("cols", String(term.cols));
		urlParams.set("rows", String(term.rows));

		const wsUrl = `${protocol}//${window.location.host}/terminal?${urlParams}`;

		const ws = new WebSocket(wsUrl);
		ws.binaryType = "arraybuffer";
		const sendSize = () => {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(
					`${RESIZE_MESSAGE_PREFIX}${JSON.stringify({ cols: term.cols, rows: term.rows })}`,
				);
			}
		};
		ws.addEventListener("open", () => {
			onStatusChange?.("connected");
			safeFit();
			sendSize();
		});
		// Fonts can finish loading after the first measurement and change the
		// cell width; measure again once they are in.
		void document.fonts?.ready.then(() => {
			safeFit();
			sendSize();
		});

		const inputDisposable = term.onData((data) => {
			if (ws.readyState === WebSocket.OPEN) ws.send(data);
		});
		const resizeDisposable = term.onResize(sendSize);

		ws.addEventListener("message", async (event) => {
			if (typeof event.data === "string") {
				safeWrite(event.data);
				return;
			}
			if (event.data instanceof ArrayBuffer) {
				safeWrite(new Uint8Array(event.data));
				return;
			}
			if (event.data instanceof Blob) {
				safeWrite(new Uint8Array(await event.data.arrayBuffer()));
			}
		});
		ws.addEventListener("close", (event) => {
			onStatusChange?.(event.code === 1000 ? "disconnected" : "error");
			if (event.code !== 1000) {
				safeWriteln(
					`\r\n[connection closed${event.reason ? `: ${event.reason}` : ""}]`,
				);
			}
		});
		ws.addEventListener("error", () => {
			onStatusChange?.("error");
			safeWriteln("\r\n[terminal connection error]");
		});

		const resizeObserver = new ResizeObserver(safeFit);
		resizeObserver.observe(container);

		return () => {
			disposed = true;
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
		<div className="h-full min-h-0 w-full overflow-hidden py-2 pl-3 pr-1">
			<div id={id} ref={termRef} className="h-full w-full min-h-64" />
		</div>
	);
};
