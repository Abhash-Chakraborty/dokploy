import { format, parseISO } from "date-fns";
import { Activity, CheckCircle2, Loader2, Rocket, XCircle } from "lucide-react";
import { useState } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
	type ChartConfig,
	ChartContainer,
	ChartLegend,
	ChartLegendContent,
	ChartTooltip,
	ChartTooltipContent,
} from "@/components/ui/chart";
import { Progress } from "@/components/ui/progress";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { api } from "@/utils/api";

type RangeDays = 7 | 30 | 90;

const chartConfig = {
	done: { label: "Succeeded", color: "hsl(var(--chart-1))" },
	error: { label: "Failed", color: "hsl(var(--chart-5))" },
	cancelled: { label: "Cancelled", color: "hsl(var(--chart-3))" },
	running: { label: "Running", color: "hsl(var(--chart-2))" },
} satisfies ChartConfig;

const StatCard = ({
	title,
	value,
	hint,
	icon,
}: {
	title: string;
	value: string | number;
	hint?: string;
	icon: React.ReactNode;
}) => (
	<Card className="bg-background">
		<CardHeader className="flex flex-row items-center justify-between pb-2">
			<CardTitle className="text-sm font-medium">{title}</CardTitle>
			{icon}
		</CardHeader>
		<CardContent className="flex flex-col gap-0.5">
			<span className="text-2xl font-bold">{value}</span>
			{hint ? (
				<span className="text-xs text-muted-foreground">{hint}</span>
			) : null}
		</CardContent>
	</Card>
);

const EmptyState = ({ message }: { message: string }) => (
	<div className="flex min-h-[12rem] items-center justify-center">
		<span className="text-sm text-muted-foreground">{message}</span>
	</div>
);

export const ShowAnalytics = () => {
	const [rangeDays, setRangeDays] = useState<RangeDays>(30);
	const { data, isLoading, error } = api.overview.analytics.useQuery({
		rangeDays,
	});

	if (error) {
		return (
			<Card className="bg-background">
				<CardContent className="flex flex-col items-center gap-2 py-10">
					<XCircle className="size-6 text-destructive" />
					<span className="text-sm text-muted-foreground">{error.message}</span>
				</CardContent>
			</Card>
		);
	}

	const hasDeployments = (data?.totals.deployments ?? 0) > 0;
	const byType = Object.entries(data?.serviceInventory.byType ?? {}).sort(
		(a, b) => b[1] - a[1],
	);
	const topProjects = data?.topProjects ?? [];
	const maxProjectDeployments = topProjects[0]?.deployments ?? 0;

	return (
		<div className="flex w-full flex-col gap-6">
			<div className="flex justify-end">
				<Select
					value={String(rangeDays)}
					onValueChange={(value) => setRangeDays(Number(value) as RangeDays)}
				>
					<SelectTrigger className="w-44">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="7">Last 7 days</SelectItem>
						<SelectItem value="30">Last 30 days</SelectItem>
						<SelectItem value="90">Last 90 days</SelectItem>
					</SelectContent>
				</Select>
			</div>

			<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
				<StatCard
					title="Deployments"
					value={data?.totals.deployments ?? 0}
					hint={`Last ${rangeDays} days`}
					icon={<Rocket className="size-4 text-muted-foreground" />}
				/>
				<StatCard
					title="Success rate"
					value={
						data?.totals.successRate === null ||
						data?.totals.successRate === undefined
							? "—"
							: `${data.totals.successRate}%`
					}
					hint={
						data?.totals.successRate === null
							? "No deployments in range"
							: undefined
					}
					icon={<CheckCircle2 className="size-4 text-muted-foreground" />}
				/>
				<StatCard
					title="Busiest day"
					value={
						data?.totals.busiestDay
							? format(parseISO(data.totals.busiestDay), "MMM d")
							: "—"
					}
					hint={
						data?.totals.busiestDayCount
							? `${data.totals.busiestDayCount} deployments`
							: undefined
					}
					icon={<Activity className="size-4 text-muted-foreground" />}
				/>
				<StatCard
					title="Services"
					value={data?.serviceInventory.total ?? 0}
					hint={`${data?.serviceInventory.byState.running ?? 0} running · ${data?.serviceInventory.byState.errored ?? 0} errored`}
					icon={<Activity className="size-4 text-muted-foreground" />}
				/>
			</div>

			<Card className="bg-background">
				<CardHeader>
					<CardTitle>Deployments over time</CardTitle>
					<span className="text-sm text-muted-foreground">
						Daily deployment counts by outcome. Days with no deployments are
						shown as zero.
					</span>
				</CardHeader>
				<CardContent>
					{isLoading ? (
						<div className="flex min-h-[12rem] items-center justify-center">
							<Loader2 className="size-5 animate-spin text-muted-foreground" />
						</div>
					) : !hasDeployments ? (
						<EmptyState message="No deployments in this range yet." />
					) : (
						<ChartContainer config={chartConfig} className="h-64 w-full">
							<BarChart
								data={data?.deploymentsOverTime ?? []}
								margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
							>
								<CartesianGrid vertical={false} />
								<XAxis
									dataKey="day"
									tickLine={false}
									axisLine={false}
									tickMargin={8}
									minTickGap={24}
									tickFormatter={(value: string) =>
										format(parseISO(value), "MMM d")
									}
								/>
								<YAxis
									tickLine={false}
									axisLine={false}
									allowDecimals={false}
									width={32}
								/>
								<ChartTooltip content={<ChartTooltipContent />} />
								<ChartLegend content={<ChartLegendContent />} />
								<Bar dataKey="done" stackId="a" fill="var(--color-done)" />
								<Bar dataKey="error" stackId="a" fill="var(--color-error)" />
								<Bar
									dataKey="cancelled"
									stackId="a"
									fill="var(--color-cancelled)"
								/>
								<Bar
									dataKey="running"
									stackId="a"
									fill="var(--color-running)"
									radius={[4, 4, 0, 0]}
								/>
							</BarChart>
						</ChartContainer>
					)}
				</CardContent>
			</Card>

			<div className="grid gap-6 lg:grid-cols-2">
				<Card className="bg-background">
					<CardHeader>
						<CardTitle>Service inventory</CardTitle>
						<span className="text-sm text-muted-foreground">
							What this organization runs, by service type.
						</span>
					</CardHeader>
					<CardContent>
						{byType.length === 0 ? (
							<EmptyState message="No services yet." />
						) : (
							<div className="flex flex-col gap-3">
								{byType.map(([type, count]) => (
									<div key={type} className="flex flex-col gap-1.5">
										<div className="flex items-center justify-between">
											<span className="text-sm font-medium capitalize">
												{type}
											</span>
											<span className="text-sm text-muted-foreground">
												{count}
											</span>
										</div>
										<Progress
											value={
												data?.serviceInventory.total
													? (count / data.serviceInventory.total) * 100
													: 0
											}
											className="h-2"
										/>
									</div>
								))}
							</div>
						)}
					</CardContent>
				</Card>

				<Card className="bg-background">
					<CardHeader>
						<CardTitle>Most active projects</CardTitle>
						<span className="text-sm text-muted-foreground">
							Ranked by deployments in the selected range.
						</span>
					</CardHeader>
					<CardContent>
						{topProjects.length === 0 ? (
							<EmptyState message="No deployments in this range yet." />
						) : (
							<div className="flex flex-col gap-3">
								{topProjects.map((project) => (
									<div
										key={project.projectId}
										className="flex flex-col gap-1.5"
									>
										<div className="flex items-center justify-between">
											<span className="truncate text-sm font-medium">
												{project.projectName}
											</span>
											<Badge variant="secondary">{project.deployments}</Badge>
										</div>
										<Progress
											value={
												maxProjectDeployments
													? (project.deployments / maxProjectDeployments) * 100
													: 0
											}
											className="h-2"
										/>
									</div>
								))}
							</div>
						)}
					</CardContent>
				</Card>
			</div>
		</div>
	);
};
