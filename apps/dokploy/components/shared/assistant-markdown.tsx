import ReactMarkdown from "react-markdown";

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	"#39": "'",
	nbsp: " ",
};

/**
 * Some models answer in HTML even when asked for Markdown. Rendering that
 * HTML would mean trusting model output in the page, so it is turned back
 * into Markdown and rendered like any other reply.
 */
export const htmlToMarkdown = (text: string) => {
	if (
		!/<\/?(p|br|ul|ol|li|strong|b|em|i|code|pre|h[1-6]|a)\b[^>]*>/i.test(text)
	) {
		return text;
	}
	return text
		.replace(
			/<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi,
			"\n```\n$1\n```\n",
		)
		.replace(
			/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
			(_, level, body) => `\n${"#".repeat(Number(level))} ${body}\n`,
		)
		.replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, "**$2**")
		.replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, "_$2_")
		.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
		.replace(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
		.replace(/<li[^>]*>/gi, "\n- ")
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|ul|ol|li)>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, name) => ENTITIES[name] ?? "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
};

export const AssistantMarkdown = ({ children }: { children: string }) => (
	<div className="prose prose-sm dark:prose-invert max-w-none wrap-break-word text-sm text-foreground prose-p:my-1.5 prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5 prose-pre:my-2 prose-pre:bg-muted prose-pre:text-foreground prose-code:before:content-none prose-code:after:content-none">
		<ReactMarkdown>{htmlToMarkdown(children)}</ReactMarkdown>
	</div>
);
