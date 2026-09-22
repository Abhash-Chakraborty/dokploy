import { db } from "@dokploy/server/db";
import { notifications } from "@dokploy/server/db/schema";
import { and, eq } from "drizzle-orm";
import {
	sendCustomNotification,
	sendDiscordNotification,
	sendEmailNotification,
	sendGotifyNotification,
	sendLarkNotification,
	sendMattermostNotification,
	sendNtfyNotification,
	sendPushoverNotification,
	sendResendNotification,
	sendSlackNotification,
	sendTeamsNotification,
	sendTelegramNotification,
} from "./utils";

export interface ContainerHealthAlert {
	serverName: string;
	/** Dokploy's name for the service, or the raw container/service name. */
	service: string;
	project?: string;
	environment?: string;
	detail: string;
	failures: number;
	exitCode: number | null;
	/** Absolute link to the service in the dashboard, when it is managed. */
	url?: string;
}

const escapeHtml = (value: string) =>
	value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const sendContainerHealthNotifications = async (
	organizationId: string,
	alert: ContainerHealthAlert,
) => {
	const date = new Date();
	const title = `Crash loop: ${alert.service}`;
	const where = [alert.project, alert.environment].filter(Boolean).join(" / ");
	const facts: Array<{ name: string; value: string }> = [
		{ name: "Service", value: alert.service },
		...(where ? [{ name: "Project", value: where }] : []),
		{ name: "Server", value: alert.serverName },
		{ name: "Failures", value: String(alert.failures) },
		...(alert.exitCode !== null
			? [{ name: "Last exit code", value: String(alert.exitCode) }]
			: []),
		{ name: "Detail", value: alert.detail },
		...(alert.url ? [{ name: "Open", value: alert.url }] : []),
	];
	const plain = facts.map((f) => `${f.name}: ${f.value}`).join("\n");

	const list = await db.query.notifications.findMany({
		where: and(
			eq(notifications.containerHealth, true),
			eq(notifications.organizationId, organizationId),
		),
		with: {
			email: true,
			discord: true,
			telegram: true,
			slack: true,
			resend: true,
			gotify: true,
			ntfy: true,
			mattermost: true,
			custom: true,
			lark: true,
			pushover: true,
			teams: true,
		},
	});

	for (const notification of list) {
		const {
			email,
			resend,
			discord,
			telegram,
			slack,
			gotify,
			ntfy,
			mattermost,
			custom,
			lark,
			pushover,
			teams,
		} = notification;
		try {
			if (email || resend) {
				const html = `<h2>${escapeHtml(title)}</h2><table>${facts
					.map(
						(f) =>
							`<tr><td><b>${escapeHtml(f.name)}</b></td><td>${escapeHtml(f.value)}</td></tr>`,
					)
					.join("")}</table>`;
				if (email) await sendEmailNotification(email, title, html);
				if (resend) await sendResendNotification(resend, title, html);
			}
			if (discord) {
				await sendDiscordNotification(discord, {
					title: `\`🔁\` ${title}`,
					color: 0xed4245,
					fields: facts.map((f) => ({
						name: f.name,
						value: f.name === "Detail" ? `\`\`\`${f.value}\`\`\`` : f.value,
						inline: f.name !== "Detail" && f.name !== "Open",
					})),
					timestamp: date.toISOString(),
					footer: { text: "Dokploy crash-loop watch" },
				});
			}
			if (telegram) {
				await sendTelegramNotification(
					telegram,
					`<b>🔁 ${escapeHtml(title)}</b>\n\n${facts
						.map((f) => `<b>${escapeHtml(f.name)}:</b> ${escapeHtml(f.value)}`)
						.join("\n")}`,
				);
			}
			if (slack) {
				await sendSlackNotification(slack, {
					channel: slack.channel,
					attachments: [
						{
							color: "#ED4245",
							pretext: `:repeat: *${title}*`,
							fields: facts.map((f) => ({
								title: f.name,
								value: f.value,
								short: f.name !== "Detail",
							})),
						},
					],
				});
			}
			if (gotify) {
				await sendGotifyNotification(gotify, title, plain);
			}
			if (ntfy) {
				await sendNtfyNotification(ntfy, title, "repeat,warning", "", plain);
			}
			if (mattermost) {
				await sendMattermostNotification(mattermost, {
					text: `**🔁 ${title}**\n\n${facts.map((f) => `**${f.name}:** ${f.value}`).join("\n")}`,
					channel: mattermost.channel,
					username: mattermost.username || "Dokploy",
				});
			}
			if (custom) {
				await sendCustomNotification(custom, {
					title,
					message: alert.detail,
					type: "container-crash-loop",
					status: "alert",
					service: alert.service,
					project: alert.project,
					environment: alert.environment,
					serverName: alert.serverName,
					failures: alert.failures,
					exitCode: alert.exitCode,
					url: alert.url,
					timestamp: date.toISOString(),
				});
			}
			if (lark) {
				await sendLarkNotification(lark, {
					msg_type: "text",
					content: { text: `🔁 ${title}\n${plain}` },
				});
			}
			if (pushover) {
				await sendPushoverNotification(pushover, title, plain);
			}
			if (teams) {
				await sendTeamsNotification(teams, { title: `🔁 ${title}`, facts });
			}
		} catch (error) {
			console.error("[crash-watch] notification failed", error);
		}
	}
	return list.length;
};
