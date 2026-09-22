import { Bot, Check, Loader2, Play, Send, Wrench } from "lucide-react";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { AssistantMarkdown } from "@/components/shared/assistant-markdown";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { api, type RouterOutputs } from "@/utils/api";

type ChatResult = RouterOutputs["ai"]["chat"];
type ChatMessage = {
	role: "user" | "assistant";
	content: string;
	tools?: ChatResult["tools"];
	actions?: ChatResult["actions"];
	durationMs?: number;
};
type Permission = "read" | "write" | "debug";

const PERMISSION_LABELS: Record<Permission, string> = {
	read: "Read",
	write: "Write",
	debug: "Debug",
};

/**
 * Right-side AI assistant panel. Has context about the current page and a
 * configurable permission level. The agent is advisory only — it proposes
 * confirmable steps and never executes actions directly.
 */
export const AiSidebar = () => {
	const pathname = usePathname();
	const { data: providers } = api.ai.getEnabledProviders.useQuery();
	const { mutateAsync, isPending } = api.ai.chat.useMutation();
	const runAction = api.ai.runAction.useMutation();
	const [ran, setRan] = useState<Record<string, "running" | "done">>({});

	const [open, setOpen] = useState(false);
	const [aiId, setAiId] = useState<string>("");
	const [permission, setPermission] = useState<Permission>("read");
	const [input, setInput] = useState("");
	const [messages, setMessages] = useState<ChatMessage[]>([]);

	const effectiveAiId = aiId || providers?.[0]?.aiId || "";

	const send = async () => {
		const text = input.trim();
		if (!text) return;
		if (!effectiveAiId) {
			toast.error("Configure an AI provider in Settings → AI first");
			return;
		}
		const next = [...messages, { role: "user" as const, content: text }];
		setMessages(next);
		setInput("");
		try {
			const res = await mutateAsync({
				aiId: effectiveAiId,
				message: text,
				permission,
				pageContext: `The user is currently on the page: ${pathname}`,
				history: messages
					.slice(-10)
					.map(({ role, content }) => ({ role, content })),
			});
			setMessages([
				...next,
				{
					role: "assistant",
					content: res.reply,
					tools: res.tools,
					actions: res.actions,
					durationMs: res.durationMs,
				},
			]);
		} catch (error) {
			setMessages([
				...next,
				{
					role: "assistant",
					content:
						error instanceof Error
							? `Error: ${error.message}`
							: "Something went wrong.",
				},
			]);
		}
	};

	return (
		<Sheet open={open} onOpenChange={setOpen}>
			<SheetTrigger asChild>
				<Button
					variant="outline"
					size="icon"
					className="fixed bottom-4 right-4 z-40 rounded-full shadow-md"
					aria-label="Open AI assistant"
				>
					<Bot className="size-5" />
				</Button>
			</SheetTrigger>
			<SheetContent
				side="right"
				className="flex w-full flex-col gap-0 sm:max-w-md"
			>
				{/* The sheet's own close button sits at top-3 right-3. */}
				<SheetHeader className="gap-0.5 px-4 pt-4 pr-12 pb-3">
					<SheetTitle className="flex items-center gap-2">
						<Bot className="size-4" /> AI Assistant
					</SheetTitle>
					<SheetDescription>
						Looks things up with your permissions. Changes wait for you to
						confirm.
					</SheetDescription>
				</SheetHeader>

				<div className="flex items-center gap-2 px-4 pb-3">
					<Select
						value={effectiveAiId}
						onValueChange={setAiId}
						disabled={!providers || providers.length === 0}
					>
						<SelectTrigger className="min-w-0 flex-1">
							<SelectValue placeholder="AI provider" />
						</SelectTrigger>
						<SelectContent>
							{providers?.map((p) => (
								<SelectItem key={p.aiId} value={p.aiId}>
									{p.name} ({p.model})
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Select
						value={permission}
						onValueChange={(v) => setPermission(v as Permission)}
					>
						<SelectTrigger className="w-24 shrink-0" aria-label="Mode">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{(Object.keys(PERMISSION_LABELS) as Permission[]).map((p) => (
								<SelectItem key={p} value={p}>
									{PERMISSION_LABELS[p]}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>

				<div className="mx-4 min-h-0 flex-1 space-y-3 overflow-y-auto rounded-md border p-3 text-sm">
					{messages.length === 0 ? (
						<p className="text-muted-foreground">
							Ask about this page, your deployments, backups, schedules, or how
							to do something in Dokploy.
						</p>
					) : (
						messages.map((m, i) => (
							<div
								key={`${m.role}-${i}`}
								className={
									m.role === "user"
										? "whitespace-pre-wrap rounded-md bg-muted px-2.5 py-1.5 text-foreground"
										: "text-foreground"
								}
							>
								{m.role === "user" ? (
									m.content
								) : (
									<AssistantMarkdown>{m.content}</AssistantMarkdown>
								)}
								{!!m.tools?.length && (
									<div className="mt-1.5 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
										<Wrench className="size-3" />
										{m.tools.map((t, index) => (
											<span
												key={`${t.tool}-${index}`}
												className={
													t.ok
														? "rounded bg-muted px-1.5 py-0.5"
														: "rounded bg-red-500/10 px-1.5 py-0.5 text-red-500"
												}
											>
												{t.tool}
												{t.ms ? ` ${t.ms}ms` : ""}
											</span>
										))}
										{m.durationMs !== undefined && (
											<span>· {(m.durationMs / 1000).toFixed(1)}s</span>
										)}
									</div>
								)}
								{m.actions?.map((action, index) => {
									const key = `${i}-${index}`;
									return (
										<div
											key={key}
											className="mt-2 flex items-center gap-2 rounded-md border px-2.5 py-2 text-xs text-foreground"
										>
											<span
												className="min-w-0 flex-1 truncate font-mono"
												title={action.summary}
											>
												{action.summary}
											</span>
											<Button
												size="xs"
												variant={action.destructive ? "destructive" : "default"}
												disabled={!!ran[key]}
												isLoading={ran[key] === "running"}
												onClick={async () => {
													setRan((state) => ({ ...state, [key]: "running" }));
													try {
														await runAction.mutateAsync({
															tool: action.tool,
															args: action.args,
														});
														setRan((state) => ({ ...state, [key]: "done" }));
														toast.success(
															`Ran ${action.tool.replaceAll("_", " ")}`,
														);
													} catch (error) {
														setRan(({ [key]: _, ...state }) => state);
														toast.error(
															error instanceof Error
																? error.message
																: "The action failed",
														);
													}
												}}
											>
												{ran[key] === "done" ? (
													<Check className="size-3" />
												) : (
													<Play className="size-3" />
												)}
												{ran[key] === "done" ? "Done" : "Run"}
											</Button>
										</div>
									);
								})}
							</div>
						))
					)}
				</div>

				<div className="flex items-end gap-2 px-4 pt-3 pb-4">
					<Textarea
						value={input}
						onChange={(e) => setInput(e.target.value)}
						placeholder="Ask the assistant…"
						className="min-h-[44px] max-h-32"
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								send();
							}
						}}
					/>
					<Button onClick={send} disabled={isPending} size="icon">
						{isPending ? (
							<Loader2 className="size-4 animate-spin" />
						) : (
							<Send className="size-4" />
						)}
					</Button>
				</div>
			</SheetContent>
		</Sheet>
	);
};
