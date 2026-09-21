import { createHash } from "node:crypto";
import { assertSource } from "./cidr";
import type { CompiledRule } from "./compile";

export const MANAGED_CHAIN = "DOKPLOY-FW";
const BEGIN = "# BEGIN DOKPLOY FIREWALL";
const END = "# END DOKPLOY FIREWALL";

const ufwAction = (action: CompiledRule["action"]) =>
	action === "reject" ? "reject" : action;

// Everything below is written into a script that runs as root. The router
// validates these too; this is the last place a bad value could be stopped.
const assertPort = (port: string) => {
	if (!/^\d{1,5}(:\d{1,5})?$/.test(port)) {
		throw new Error(`Refusing to render a firewall rule for port "${port}"`);
	}
	return port;
};
const assertOrigin = (origin: string) => {
	if (!/^[A-Za-z0-9:._-]+$/.test(origin)) {
		throw new Error(`Refusing to render a firewall rule tagged "${origin}"`);
	}
	return origin;
};

/** One ufw command per input rule, tagged so Dokploy's rules are its own. */
export const renderUfwRules = (rules: CompiledRule[]) =>
	rules
		.filter((rule) => rule.chain === "input")
		.map((rule) => {
			// --force is only valid for enable/reset/delete, not for a rule.
			return `ufw ${ufwAction(rule.action)} from ${assertSource(rule.from)} to any port ${assertPort(rule.port)} proto ${rule.protocol} comment 'dokploy:${assertOrigin(rule.origin)}'`;
		});

/**
 * Docker publishes ports by writing its own iptables rules, which never
 * pass through ufw's INPUT chain. These go in a chain called from
 * DOCKER-USER and match the port the client originally asked for, which is
 * the only thing left after Docker's DNAT.
 */
export const renderDockerChain = (rules: CompiledRule[]) => {
	const lines = ["*filter", `:${MANAGED_CHAIN} - [0:0]`, `-F ${MANAGED_CHAIN}`];
	// A port that anything is allowed to reach is closed to everyone else,
	// but only after every rule for it has had its say: closing it straight
	// after the first allow would stop a second allowed source ever matching.
	const closed = new Map<string, string>();
	for (const rule of rules.filter(
		(candidate) => candidate.chain === "docker",
	)) {
		const target =
			rule.action === "deny"
				? "DROP"
				: rule.action === "reject"
					? "REJECT"
					: "RETURN";
		const source = assertSource(rule.from);
		const from = source === "any" ? "" : ` -s ${source}`;
		const port = assertPort(rule.port);
		lines.push(
			`-A ${MANAGED_CHAIN}${from} -p ${rule.protocol} -m conntrack --ctorigdstport ${port} -j ${target} -m comment --comment "dokploy:${assertOrigin(rule.origin)}"`,
		);
		if (target === "RETURN" && !closed.has(`${rule.protocol}:${port}`)) {
			closed.set(
				`${rule.protocol}:${port}`,
				`-A ${MANAGED_CHAIN} -p ${rule.protocol} -m conntrack --ctorigdstport ${port} -j DROP -m comment --comment "dokploy:${assertOrigin(rule.origin)}:default-deny"`,
			);
		}
	}
	lines.push(...closed.values());
	lines.push(`-A ${MANAGED_CHAIN} -j RETURN`);
	lines.push(`-I DOCKER-USER -j ${MANAGED_CHAIN}`);
	lines.push("COMMIT");
	return lines.join("\n");
};

export type RenderedFirewall = {
	ufw: string[];
	dockerBlock: string;
	hash: string;
};

export const render = (rules: CompiledRule[]): RenderedFirewall => {
	const ufw = renderUfwRules(rules);
	const dockerBlock = [BEGIN, renderDockerChain(rules), END].join("\n");
	return {
		ufw,
		dockerBlock,
		hash: createHash("sha256")
			.update(JSON.stringify({ ufw, dockerBlock }))
			.digest("hex")
			.slice(0, 16),
	};
};

export const RULES_DIR = "/etc/dokploy/abhash/firewall";

/**
 * The script that applies a ruleset. It snapshots first, arms a rollback
 * that fires unless Dokploy confirms, and only then changes anything — so a
 * mistake restores itself in two minutes instead of locking you out.
 */
export const applyScript = (
	rendered: RenderedFirewall,
	options: { rollbackSeconds: number; defaultIncoming: "deny" | "allow" },
) => `set -eu
DIR=${RULES_DIR}
mkdir -p "$DIR"

# 1. Snapshot, so the rollback has something to restore.
iptables-save > "$DIR/iptables.backup"
if command -v ufw >/dev/null 2>&1; then
	cp -a /etc/ufw "$DIR/ufw.backup" 2>/dev/null || true
	ufw status verbose > "$DIR/ufw.before" 2>/dev/null || true
fi

cat > "$DIR/rollback.sh" <<'ROLLBACK'
#!/bin/sh
set -eu
DIR=${RULES_DIR}
[ -f "$DIR/confirmed" ] && exit 0
iptables-restore < "$DIR/iptables.backup" 2>/dev/null || true
if [ -d "$DIR/ufw.backup" ]; then
	rm -rf /etc/ufw && cp -a "$DIR/ufw.backup" /etc/ufw
	ufw reload >/dev/null 2>&1 || true
fi
echo "dokploy firewall rolled back at $(date -Is)" >> "$DIR/rollback.log"
ROLLBACK
chmod +x "$DIR/rollback.sh"
rm -f "$DIR/confirmed"

# 2. Arm the rollback. systemd-run when there is systemd, a background
#    sleep otherwise, so this works on a plain container too.
if command -v systemd-run >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
	systemd-run --unit=dokploy-firewall-rollback --on-active=${options.rollbackSeconds} "$DIR/rollback.sh" >/dev/null 2>&1
	echo systemd > "$DIR/rollback.mode"
else
	nohup sh -c 'sleep ${options.rollbackSeconds}; ${RULES_DIR}/rollback.sh' >/dev/null 2>&1 &
	echo $! > "$DIR/rollback.pid"
	echo nohup > "$DIR/rollback.mode"
fi

# 3. Apply. ufw owns the host's own ports. Only the rules Dokploy tagged as
#    its own are replaced: whatever else is configured on this server was put
#    there on purpose and is none of this script's business.
ufw show added 2>/dev/null | grep "comment 'dokploy:" | sed 's/^ufw /ufw --force delete /' > "$DIR/owned.delete" || true
if [ -s "$DIR/owned.delete" ]; then sh "$DIR/owned.delete" >/dev/null; fi
ufw default ${options.defaultIncoming} incoming >/dev/null
ufw default allow outgoing >/dev/null
${rendered.ufw.join("\n")}
ufw --force enable >/dev/null

# 4. Published container ports, which never reach ufw's chains.
AFTER=/etc/ufw/after.rules
sed -i '/${BEGIN}/,/${END}/d' "$AFTER" 2>/dev/null || true
cat >> "$AFTER" <<'DOCKERBLOCK'
${rendered.dockerBlock}
DOCKERBLOCK
ufw reload >/dev/null 2>&1 || true
echo "${rendered.hash}" > "$DIR/applied.hash"
echo "APPLIED ${rendered.hash}"
`;

/** Run over a fresh connection: cancels the rollback that was armed. */
export const confirmScript = () => `set -eu
DIR=${RULES_DIR}
touch "$DIR/confirmed"
if [ -f "$DIR/rollback.pid" ]; then
	kill "$(cat "$DIR/rollback.pid")" 2>/dev/null || true
	rm -f "$DIR/rollback.pid"
fi
systemctl stop dokploy-firewall-rollback.timer 2>/dev/null || true
systemctl stop dokploy-firewall-rollback.service 2>/dev/null || true
echo CONFIRMED
`;

/** What is actually in place, for the drift check. */
export const inspectScript = () => `set -eu
DIR=${RULES_DIR}
echo "HASH=$(cat "$DIR/applied.hash" 2>/dev/null || echo none)"
echo "UFW=$(ufw status 2>/dev/null | head -1 | awk '{print $2}' || echo missing)"
echo "RULES=$(ufw status 2>/dev/null | grep -c 'dokploy:' || true)"
echo "CHAIN=$(iptables -S ${MANAGED_CHAIN} 2>/dev/null | wc -l)"
`;
