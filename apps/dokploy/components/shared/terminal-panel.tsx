import { SquareTerminal } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from "@/components/ui/sheet";
import { TerminalView } from "./terminal-view";

interface TerminalPanelProps {
	/** Custom trigger. Defaults to a "Terminal" button. */
	children?: ReactNode;
	defaultServerId?: string;
}

/**
 * Slide-over terminal panel. Opens a developer shell in a right-side Sheet,
 * defaulting to the local Dokploy server with a selector to switch servers.
 * Use anywhere a quick terminal is needed without leaving the page.
 */
export const TerminalPanel = ({
	children,
	defaultServerId = "local",
}: TerminalPanelProps) => {
	const [open, setOpen] = useState(false);

	return (
		<Sheet open={open} onOpenChange={setOpen}>
			<SheetTrigger asChild>
				{children ?? (
					<Button variant="outline" size="sm">
						<SquareTerminal className="size-4" />
						Terminal
					</Button>
				)}
			</SheetTrigger>
			<SheetContent
				side="right"
				className="w-full sm:max-w-3xl flex flex-col"
				onEscapeKeyDown={(e) => e.preventDefault()}
			>
				<SheetHeader>
					<SheetTitle className="flex items-center gap-2">
						<SquareTerminal className="size-4" />
						Terminal
					</SheetTitle>
					<SheetDescription>
						Developer shell — pick a server to connect.
					</SheetDescription>
				</SheetHeader>
				{open && (
					<TerminalView
						defaultServerId={defaultServerId}
						className="flex-1"
						heightClassName="h-[calc(100vh-180px)]"
					/>
				)}
			</SheetContent>
		</Sheet>
	);
};
