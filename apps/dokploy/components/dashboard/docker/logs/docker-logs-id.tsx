import copy from "copy-to-clipboard";
import {
	Check,
	Copy,
	Download as DownloadIcon,
	Loader2,
	Pause,
	Play,
	Search,
} from "lucide-react";
import React, { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { api } from "@/utils/api";
import { AnalyzeLogs } from "./analyze-logs";
import { LineCountFilter } from "./line-count-filter";
import { SinceLogsFilter, type TimeFilter } from "./since-logs-filter";
import { StatusLogsFilter } from "./status-logs-filter";
import { TerminalLine } from "./terminal-line";
import { getLogType, type LogLine, parseLogs } from "./utils";

interface Props {
	containerId: string;
	serverId?: string | null;
	runType: "swarm" | "native";
	serviceId?: string;
	/** Rendered first on the filter row, e.g. a container picker. */
	toolbarStart?: React.ReactNode;
}

// Sentinel the container-picker views fall back to before a real container
// is selected/auto-selected — querying logs for it just surfaces Docker's
// raw "No such container: select-a-container" daemon error.
const PLACEHOLDER_CONTAINER_ID = "select-a-container";

export const priorities = [
	{
		label: "Info",
		value: "info",
	},
	{
		label: "Success",
		value: "success",
	},
	{
		label: "Warning",
		value: "warning",
	},
	{
		label: "Debug",
		value: "debug",
	},
	{
		label: "Error",
		value: "error",
	},
];

export const DockerLogsId: React.FC<Props> = ({
	containerId,
	serverId,
	runType,
	serviceId,
	toolbarStart,
}) => {
	const hasContainer =
		!!containerId && containerId !== PLACEHOLDER_CONTAINER_ID;

	const { data } = api.docker.getConfig.useQuery(
		{
			containerId,
			serverId: serverId ?? undefined,
		},
		{
			enabled: hasContainer,
		},
	);

	const [rawLogs, setRawLogs] = React.useState("");
	const [filteredLogs, setFilteredLogs] = React.useState<LogLine[]>([]);
	const [autoScroll, setAutoScroll] = React.useState(true);
	const [lines, setLines] = React.useState<number>(100);
	const [search, setSearch] = React.useState<string>("");
	const [showTimestamp, setShowTimestamp] = React.useState(true);
	const [since, setSince] = React.useState<TimeFilter>("all");
	const [typeFilter, setTypeFilter] = React.useState<string[]>([]);
	const [isPaused, setIsPaused] = React.useState(false);
	const [messageBuffer, setMessageBuffer] = React.useState<string[]>([]);
	const isPausedRef = useRef(false);
	const scrollRef = useRef<HTMLDivElement>(null);
	const [isLoading, setIsLoading] = React.useState(false);
	const [copied, setCopied] = React.useState(false);

	const scrollToBottom = () => {
		if (autoScroll && scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	};

	const handleScroll = () => {
		if (!scrollRef.current) return;

		const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
		const isAtBottom = Math.abs(scrollHeight - scrollTop - clientHeight) < 10;
		setAutoScroll(isAtBottom);
	};

	const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
		setSearch(e.target.value || "");
	};

	const handleLines = (lines: number) => {
		setRawLogs("");
		setFilteredLogs([]);
		setMessageBuffer([]);
		setLines(lines);
	};

	const handleSince = (value: TimeFilter) => {
		setRawLogs("");
		setFilteredLogs([]);
		setMessageBuffer([]);
		setSince(value);
	};

	const handlePauseResume = () => {
		if (isPaused) {
			// Resume: Apply all buffered messages
			if (messageBuffer.length > 0) {
				const bufferedContent = messageBuffer.join("");
				setRawLogs((prev) => {
					const updated = prev + bufferedContent;
					const splitLines = updated.split("\n");
					if (splitLines.length > lines) {
						return splitLines.slice(-lines).join("\n");
					}
					return updated;
				});
				setMessageBuffer([]);
			}
		}
		const newPausedState = !isPaused;
		setIsPaused(newPausedState);
		isPausedRef.current = newPausedState;
	};

	useEffect(() => {
		if (!hasContainer) return;

		let isCurrentConnection = true;
		let noDataTimeout: NodeJS.Timeout;
		setIsLoading(true);
		setRawLogs("");
		setFilteredLogs([]);
		setMessageBuffer([]);
		// Reset pause state when container changes
		setIsPaused(false);
		isPausedRef.current = false;

		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
		const params = new globalThis.URLSearchParams({
			containerId,
			tail: lines.toString(),
			since,
			search,
			runType,
		});

		if (serverId) {
			params.append("serverId", serverId);
		}

		if (serviceId) {
			params.append("serviceId", serviceId);
		}

		const wsUrl = `${protocol}//${
			window.location.host
		}/docker-container-logs?${params.toString()}`;
		const ws = new WebSocket(wsUrl);

		const resetNoDataTimeout = () => {
			if (noDataTimeout) clearTimeout(noDataTimeout);
			noDataTimeout = setTimeout(() => {
				if (isCurrentConnection) {
					setIsLoading(false);
				}
			}, 2000); // Wait 2 seconds for data before showing "No logs found"
		};

		ws.onopen = () => {
			if (!isCurrentConnection) {
				ws.close();
				return;
			}
			resetNoDataTimeout();
		};

		ws.onmessage = (e) => {
			if (!isCurrentConnection) return;

			if (isPausedRef.current) {
				// When paused, buffer the messages instead of displaying them
				setMessageBuffer((prev) => [...prev, e.data]);
			} else {
				// When not paused, display messages normally
				setRawLogs((prev) => {
					const updated = prev + e.data;
					const splitLines = updated.split("\n");
					if (splitLines.length > lines) {
						return splitLines.slice(-lines).join("\n");
					}
					return updated;
				});
			}

			setIsLoading(false);
			if (noDataTimeout) clearTimeout(noDataTimeout);
		};

		ws.onerror = (error) => {
			if (!isCurrentConnection) return;
			console.error("WebSocket error:", error);
			setIsLoading(false);
			if (noDataTimeout) clearTimeout(noDataTimeout);
		};

		ws.onclose = (e) => {
			if (!isCurrentConnection) return;
			console.log("WebSocket closed:", e.reason);
			setIsLoading(false);
			if (noDataTimeout) clearTimeout(noDataTimeout);
		};

		return () => {
			isCurrentConnection = false;
			if (noDataTimeout) clearTimeout(noDataTimeout);
			if (ws.readyState === WebSocket.OPEN) {
				ws.close();
			}
		};
	}, [containerId, serverId, serviceId, lines, search, since]);

	const handleDownload = () => {
		const logContent = filteredLogs
			.map(
				({ timestamp, message }: { timestamp: Date | null; message: string }) =>
					`${timestamp?.toISOString() || "No timestamp"} ${message}`,
			)
			.join("\n");

		const blob = new Blob([logContent], { type: "text/plain" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		const appName = data.Name.replace("/", "") || "app";
		const isoDate = new Date().toISOString();
		a.href = url;
		a.download = `${appName}-${isoDate.slice(0, 10).replace(/-/g, "")}_${isoDate
			.slice(11, 19)
			.replace(/:/g, "")}.log.txt`;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	};

	const handleCopy = async () => {
		const logContent = filteredLogs
			.map(
				({
					timestamp,
					message,
				}: {
					timestamp: Date | null;
					message: string;
				}) =>
					showTimestamp
						? `${timestamp?.toISOString() || "No timestamp"} ${message}`
						: message,
			)
			.join("\n");

		const success = copy(logContent);
		if (success) {
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		}
	};

	const handleFilter = (logs: LogLine[]) => {
		return logs.filter((log) => {
			const logType = getLogType(log.message).type;

			if (typeFilter.length === 0) {
				return true;
			}

			return typeFilter.includes(logType);
		});
	};

	// Sync isPausedRef with isPaused state
	useEffect(() => {
		isPausedRef.current = isPaused;
	}, [isPaused]);

	useEffect(() => {
		setRawLogs("");
		setFilteredLogs([]);
		setMessageBuffer([]);
	}, [containerId]);

	useEffect(() => {
		const logs = parseLogs(rawLogs);
		const filtered = handleFilter(logs);
		setFilteredLogs(filtered);
	}, [rawLogs, search, lines, since, typeFilter]);

	useEffect(() => {
		scrollToBottom();

		if (autoScroll && scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [filteredLogs, autoScroll]);

	const actionClass = "size-7 [&_svg:not([class*='size-'])]:size-3.5";

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center gap-2">
				{toolbarStart}
				<LineCountFilter value={lines} onValueChange={handleLines} />
				<SinceLogsFilter
					value={since}
					onValueChange={handleSince}
					showTimestamp={showTimestamp}
					onTimestampChange={setShowTimestamp}
				/>
				<StatusLogsFilter
					value={typeFilter}
					setValue={setTypeFilter}
					title="Type"
					options={priorities}
				/>
				<div className="relative min-w-40 flex-1">
					<Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
					<Input
						type="search"
						placeholder="Search logs..."
						value={search}
						onChange={handleSearch}
						className="h-8 pl-8 text-xs"
					/>
				</div>
			</div>
			<div className="relative">
				<div className="absolute top-2 right-4 z-10 flex items-center gap-0.5 rounded-full border bg-background/80 p-0.5 shadow-sm backdrop-blur">
					{isPaused && (
						<span className="px-2 text-[11px] text-amber-500">
							Paused
							{messageBuffer.length > 0 && ` · ${messageBuffer.length} new`}
						</span>
					)}
					<Button
						variant="ghost"
						size="icon-xs"
						className={cn("rounded-full", actionClass)}
						onClick={handlePauseResume}
						title={isPaused ? "Resume logs" : "Pause logs"}
						aria-label={isPaused ? "Resume logs" : "Pause logs"}
					>
						{isPaused ? <Play /> : <Pause />}
					</Button>
					<Button
						variant="ghost"
						size="icon-xs"
						className={cn("rounded-full", actionClass)}
						onClick={handleCopy}
						disabled={filteredLogs.length === 0}
						title="Copy logs"
						aria-label="Copy logs"
					>
						{copied ? <Check /> : <Copy />}
					</Button>
					<Button
						variant="ghost"
						size="icon-xs"
						className={cn("rounded-full", actionClass)}
						onClick={handleDownload}
						disabled={filteredLogs.length === 0 || !data?.Name}
						title="Download logs"
						aria-label="Download logs"
					>
						<DownloadIcon />
					</Button>
					<AnalyzeLogs
						logs={filteredLogs}
						context="runtime"
						iconOnly
						className={cn("rounded-full", actionClass)}
					/>
				</div>
				<div
					ref={scrollRef}
					onScroll={handleScroll}
					className="h-[55vh] sm:h-[65vh] max-h-[760px] overflow-y-auto space-y-0 rounded-lg border bg-[#fafafa] p-4 pt-11 dark:bg-[#050506] custom-logs-scrollbar"
				>
					{filteredLogs.length > 0 ? (
						filteredLogs.map((filteredLog: LogLine, index: number) => (
							<TerminalLine
								key={`${filteredLog.rawTimestamp ?? ""}-${index}`}
								log={filteredLog}
								searchTerm={search}
								noTimestamp={!showTimestamp}
							/>
						))
					) : isLoading ? (
						<div className="flex justify-center items-center h-full text-muted-foreground">
							<Loader2 className="h-6 w-6 animate-spin" />
						</div>
					) : hasContainer ? (
						<div className="flex justify-center items-center h-full text-muted-foreground">
							No logs found
						</div>
					) : (
						<div className="flex justify-center items-center h-full text-center text-sm text-muted-foreground px-8">
							Pick a container to view its logs. If none are listed, make sure
							the service is deployed and running.
						</div>
					)}
				</div>
			</div>
		</div>
	);
};
