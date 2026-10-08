import { Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/router";
import { useMemo, useState } from "react";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

export interface SettingsNavGroup {
	title: string;
	items: { title: string; url: string; description?: string }[];
}

interface Props {
	groups: SettingsNavGroup[];
	pathname: string;
}

const isActive = (url: string, pathname: string) =>
	pathname === url || pathname.startsWith(`${url}/`);

export const SettingsNav = ({ groups, pathname }: Props) => {
	const router = useRouter();
	const [query, setQuery] = useState("");

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return groups;
		return groups
			.map((group) => ({
				...group,
				items: group.items.filter((item) =>
					`${group.title} ${item.title} ${item.description ?? ""}`
						.toLowerCase()
						.includes(q),
				),
			}))
			.filter((group) => group.items.length > 0);
	}, [groups, query]);

	const current = groups
		.flatMap((group) => group.items)
		.find((item) => isActive(item.url, pathname));

	return (
		<>
			<div className="lg:hidden">
				<Select value={current?.url} onValueChange={(url) => router.push(url)}>
					<SelectTrigger aria-label="Settings section">
						<SelectValue placeholder="Settings" />
					</SelectTrigger>
					<SelectContent>
						{groups.map((group) => (
							<SelectGroup key={group.title}>
								<SelectLabel>{group.title}</SelectLabel>
								{group.items.map((item) => (
									<SelectItem key={item.url} value={item.url}>
										{item.title}
									</SelectItem>
								))}
							</SelectGroup>
						))}
					</SelectContent>
				</Select>
			</div>
			<nav
				aria-label="Settings"
				className="hidden lg:flex lg:w-52 lg:shrink-0 lg:flex-col lg:gap-0.5 lg:sticky lg:top-4 lg:self-start"
			>
				<div className="relative mb-2">
					<Search className="pointer-events-none absolute left-2.5 top-2 size-4 text-muted-foreground" />
					<Input
						aria-label="Search settings"
						placeholder="Search settings"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						className="pl-8"
					/>
				</div>
				{filtered.map((group) => (
					<div key={group.title} className="flex flex-col gap-0.5">
						<span className="px-2.5 pt-3 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
							{group.title}
						</span>
						{group.items.map((item) => (
							<Link
								key={item.url}
								href={item.url}
								title={item.description}
								aria-current={isActive(item.url, pathname) ? "page" : undefined}
								className={cn(
									"rounded-md px-2.5 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
									isActive(item.url, pathname) &&
										"bg-accent text-foreground font-medium",
								)}
							>
								{item.title}
							</Link>
						))}
					</div>
				))}
				{filtered.length === 0 && (
					<span className="px-2.5 py-2 text-[13px] text-muted-foreground">
						Nothing matches “{query}”.
					</span>
				)}
			</nav>
		</>
	);
};
