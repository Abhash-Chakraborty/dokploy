import { AlertTriangle, RotateCcw } from "lucide-react";
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

interface Props {
	children: ReactNode;
	/** Shown in the fallback so the reader knows which part failed. */
	label?: string;
}

interface State {
	error: Error | null;
}

/**
 * Catches render errors from a dashboard route so one broken panel can't take
 * the whole shell down with it. The sidebar, breadcrumb and navigation stay
 * usable, and the reader gets the actual error plus a way to retry.
 */
export class RouteErrorBoundary extends Component<Props, State> {
	state: State = { error: null };

	static getDerivedStateFromError(error: Error): State {
		return { error };
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		console.error("Route render failed:", error, info.componentStack);
	}

	private reset = () => {
		this.setState({ error: null });
	};

	render() {
		const { error } = this.state;
		if (!error) return this.props.children;

		const { label } = this.props;

		return (
			<div className="flex min-h-[50vh] w-full items-center justify-center p-6">
				<div className="flex w-full max-w-lg flex-col items-center gap-4 rounded-xl border border-dashed bg-background p-8 text-center">
					<AlertTriangle className="size-8 text-muted-foreground" />
					<div className="flex flex-col gap-1.5">
						<h2 className="text-base font-medium">
							{label
								? `${label} failed to render`
								: "This page failed to render"}
						</h2>
						<p className="text-sm text-muted-foreground">
							The rest of the dashboard is still working. Retrying re-renders
							just this section.
						</p>
					</div>
					<pre className="max-h-40 w-full overflow-auto rounded-lg bg-muted p-3 text-left font-mono text-xs text-muted-foreground">
						{error.message || String(error)}
					</pre>
					<div className="flex flex-wrap justify-center gap-2">
						<Button variant="outline" onClick={this.reset}>
							<RotateCcw className="size-4" />
							Retry
						</Button>
						<Button variant="ghost" onClick={() => window.location.reload()}>
							Reload page
						</Button>
					</div>
				</div>
			</div>
		);
	}
}
