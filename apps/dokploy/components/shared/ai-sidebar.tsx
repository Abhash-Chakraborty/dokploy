import { Bot, Loader2, Send } from "lucide-react";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
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
import { api } from "@/utils/api";

type ChatMessage = { role: "user" | "assistant"; content: string };
type Permission = "read" | "write" | "debug";

const PERMISSION_LABELS: Record<Permission, string> = {
	read: "Read-only",
	write: "Write (advisory)",
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
				history: messages.slice(-10),
			});
			setMessages([...next, { role: "assistant", content: res.reply }]);
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
			<SheetContent side="right" className="w-full sm:max-w-md flex flex-col">
				<SheetHeader>
					<SheetTitle className="flex items-center gap-2">
						<Bot className="size-4" /> AI Assistant
					</SheetTitle>
					<SheetDescription>
						Context-aware help. Advisory only — actions need your confirmation.
					</SheetDescription>
				</SheetHeader>

				<div className="flex items-center gap-2 py-2">
					<Select
						value={effectiveAiId}
						onValueChange={setAiId}
						disabled={!providers || providers.length === 0}
					>
						<SelectTrigger className="flex-1">
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
						<SelectTrigger className="w-36">
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

				<div className="flex-1 overflow-y-auto rounded-md border p-3 space-y-3 text-sm">
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
										? "text-foreground"
										: "text-muted-foreground whitespace-pre-wrap"
								}
							>
								<span className="font-medium">
									{m.role === "user" ? "You" : "Assistant"}:
								</span>{" "}
								{m.content}
							</div>
						))
					)}
				</div>

				<div className="flex items-end gap-2 pt-2">
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
