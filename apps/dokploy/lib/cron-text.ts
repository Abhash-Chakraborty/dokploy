const DAYS = [
	"Sundays",
	"Mondays",
	"Tuesdays",
	"Wednesdays",
	"Thursdays",
	"Fridays",
	"Saturdays",
];

const pad = (value: string) => value.padStart(2, "0");
const ordinal = (day: number) => {
	const tens = day % 100;
	if (tens >= 11 && tens <= 13) return `${day}th`;
	return `${day}${["th", "st", "nd", "rd"][day % 10] ?? "th"}`;
};
const isNum = (value: string | undefined): value is string =>
	!!value && /^\d+$/.test(value);

const MACROS: Record<string, string> = {
	"@hourly": "Every hour",
	"@daily": "Daily 00:00",
	"@midnight": "Daily 00:00",
	"@weekly": "Sundays 00:00",
	"@monthly": "1st of the month, 00:00",
	"@yearly": "Every year",
	"@annually": "Every year",
};

/** Plain-words schedule for the common cron shapes; null when unusual. */
export const describeCron = (expression?: string | null): string | null => {
	if (!expression) return null;
	const trimmed = expression.trim();
	if (MACROS[trimmed]) return MACROS[trimmed];
	const [minute, hour, dayOfMonth, month, dayOfWeek, ...rest] =
		trimmed.split(/\s+/);
	if (rest.length > 0 || month !== "*") return null;

	const everyMinutes = minute?.match(/^\*\/(\d+)$/);
	if (everyMinutes && hour === "*" && dayOfMonth === "*" && dayOfWeek === "*") {
		return everyMinutes[1] === "1"
			? "Every minute"
			: `Every ${everyMinutes[1]} minutes`;
	}
	if (!isNum(minute)) return null;

	if (hour === "*" && dayOfMonth === "*" && dayOfWeek === "*") {
		return minute === "0" ? "Every hour" : `Hourly at :${pad(minute)}`;
	}
	const everyHours = hour?.match(/^\*\/(\d+)$/);
	if (everyHours && dayOfMonth === "*" && dayOfWeek === "*") {
		const at = minute === "0" ? "" : ` at :${pad(minute)}`;
		return `Every ${everyHours[1]} hours${at}`;
	}
	if (!isNum(hour)) return null;
	const time = `${pad(hour)}:${pad(minute)}`;

	if (dayOfMonth === "*" && dayOfWeek === "*") return `Daily ${time}`;
	if (dayOfMonth === "*" && isNum(dayOfWeek)) {
		const day = DAYS[Number(dayOfWeek) % 7];
		return day ? `${day} ${time}` : null;
	}
	if (isNum(dayOfMonth) && dayOfWeek === "*") {
		return `${ordinal(Number(dayOfMonth))} of the month, ${time}`;
	}
	return null;
};
