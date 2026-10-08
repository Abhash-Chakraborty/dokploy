import { describe, expect, it } from "vitest";
import { describeCron } from "@/lib/cron-text";

describe("describeCron", () => {
	it.each([
		["0 * * * *", "Every hour"],
		["15 * * * *", "Hourly at :15"],
		["0 */6 * * *", "Every 6 hours"],
		["*/5 * * * *", "Every 5 minutes"],
		["30 23 * * *", "Daily 23:30"],
		["5 3 * * 0", "Sundays 03:05"],
		["0 3 1 * *", "1st of the month, 03:00"],
		["0 3 22 * *", "22nd of the month, 03:00"],
		["0 3 11 * *", "11th of the month, 03:00"],
		["@daily", "Daily 00:00"],
	])("%s -> %s", (expression, words) => {
		expect(describeCron(expression)).toBe(words);
	});

	it("gives up on shapes it cannot say plainly", () => {
		expect(describeCron("0 3 * 1-6 1-5")).toBeNull();
		expect(describeCron("0 3,15 * * *")).toBeNull();
		expect(describeCron("")).toBeNull();
	});
});
