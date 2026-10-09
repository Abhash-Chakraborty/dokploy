// Shell scripts for managing a server's own accounts and access. Kept pure so
// they can be tested: the router decides where they run.

export const USERNAME_PATTERN = /^[a-z_][a-z0-9_-]{0,31}$/;
const KEY_PATTERN =
	/^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com) [A-Za-z0-9+/=]+( [^\r\n]*)?$/;
export const RESCUE_USER = "rescue";
export const RESCUE_DROP_IN = "/etc/ssh/sshd_config.d/40-dokploy-rescue.conf";
// A fixed path: the revert timer runs in a later, separate shell.
const RESCUE_BACKUP = "/var/lib/dokploy-rescue.conf.bak";
const REVERT_UNIT = "dokploy-ssh-revert";

export const shellQuote = (value: string) =>
	`'${value.replace(/'/g, `'"'"'`)}'`;

/** Arbitrary text reaches the script base64-encoded, never interpolated. */
const literal = (value: string) =>
	`"$(printf %s ${shellQuote(Buffer.from(value).toString("base64"))} | base64 -d)"`;

export const validateUsername = (name: string) => {
	if (!USERNAME_PATTERN.test(name)) {
		throw new Error(
			"Use 1-32 lowercase letters, digits, - or _, starting with a letter",
		);
	}
	return name;
};

export const validatePublicKeys = (keys: string) => {
	const lines = keys
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	for (const line of lines) {
		if (!KEY_PATTERN.test(line)) {
			throw new Error(`Not an SSH public key: ${line.slice(0, 40)}…`);
		}
	}
	return lines;
};

// Runs as root, or through passwordless sudo for a cloud image's login user.
const PRELUDE = `SUDO=""
if [ "$(id -u)" -ne 0 ]; then
	if ! sudo -n true 2>/dev/null; then
		echo "ERROR the SSH user needs passwordless sudo for this" >&2
		exit 77
	fi
	SUDO="sudo -n"
fi
ADMIN_GROUP=$(getent group sudo >/dev/null && echo sudo || echo wheel)
# Anything inside a user's home runs as that user: as root, a symlink the
# user planted (say ~/.ssh/authorized_keys -> /etc/shadow) would be followed.
as_user() {
	target="$1"; shift
	if [ "$(id -u)" -eq 0 ]; then runuser -u "$target" -- "$@"; else sudo -n -u "$target" -- "$@"; fi
}
WRITE_KEYS='umask 077; mkdir -p "$1/.ssh" && cat > "$1/.ssh/authorized_keys.dokploy" && mv -f "$1/.ssh/authorized_keys.dokploy" "$1/.ssh/authorized_keys"'`;

const script = (body: string) => `${PRELUDE}\n${body}\n`;

export type HostUser = {
	name: string;
	uid: number;
	shell: string;
	home: string;
	admin: boolean;
	locked: boolean;
	keys: number;
};

export const listUsersScript = () =>
	script(`now=$(date +%s)
getent passwd | while IFS=: read -r name _ uid _ _ home shell; do
	if [ "$uid" -ne 0 ] && { [ "$uid" -lt 1000 ] || [ "$uid" -ge 65534 ]; }; then continue; fi
	admin=0
	if [ "$uid" -eq 0 ] || id -nG "$name" 2>/dev/null | tr ' ' '\\n' | grep -qxE 'sudo|wheel|admin'; then admin=1; fi
	locked=0
	expires=$($SUDO chage -l "$name" 2>/dev/null | awk -F': ' '/Account expires/{print $2}')
	if [ -n "$expires" ] && [ "$expires" != "never" ]; then
		at=$(date -d "$expires" +%s 2>/dev/null || echo 0)
		[ "$at" -le "$now" ] && locked=1
	fi
	case "$shell" in */nologin|*/false) locked=1 ;; esac
	keys=$(as_user "$name" cat "$home/.ssh/authorized_keys" 2>/dev/null | grep -cE '^(ssh-|ecdsa-|sk-)' || true)
	printf 'USER\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$name" "$uid" "$shell" "$home" "$admin" "$locked" "\${keys:-0}"
done
# Who sshd lets in at all: an account outside AllowUsers exists but cannot log in.
allow=$({ $SUDO sshd -T -C user=nobody,host=localhost,addr=127.0.0.1,laddr=127.0.0.1,lport=1 2>/dev/null || $SUDO sshd -T 2>/dev/null; } | awk '/^allowusers /{ $1=""; print substr($0,2) }' | tr '\\n' ' ')
printf 'ALLOW\\t%s\\n' "$allow"`);

/** Users sshd admits; empty when there is no AllowUsers restriction. */
export const parseAllowUsers = (stdout: string) =>
	(stdout.split("\n").find((line) => line.startsWith("ALLOW\t")) ?? "")
		.slice(6)
		.split(/\s+/)
		.filter(Boolean);

export const parseUsers = (stdout: string): HostUser[] =>
	stdout
		.split("\n")
		.filter((line) => line.startsWith("USER\t"))
		.map((line) => {
			const [, name, uid, shell, home, admin, locked, keys] = line.split("\t");
			return {
				name: name ?? "",
				uid: Number(uid),
				shell: shell ?? "",
				home: home ?? "",
				admin: admin === "1",
				locked: locked === "1",
				keys: Number(keys) || 0,
			};
		});

// No "sudo with a password" mode: these accounts log in with keys and have
// no password, so such a user could never use sudo.
export type SudoMode = "none" | "nopasswd";

const sudoersFile = (name: string) => `/etc/sudoers.d/90-dokploy-${name}`;

export const createUserScript = (input: {
	name: string;
	publicKeys: string[];
	sudo: SudoMode;
}) => {
	const name = validateUsername(input.name);
	const keys = input.publicKeys.join("\n");
	return script(`set -e
if id ${name} >/dev/null 2>&1; then echo "ERROR ${name} already exists" >&2; exit 3; fi
$SUDO useradd --create-home --shell /bin/bash ${name}
home=$(getent passwd ${name} | cut -d: -f6)
printf '%s\\n' ${literal(keys)} | as_user ${name} sh -c "$WRITE_KEYS" _ "$home"
${input.sudo === "none" ? "" : `$SUDO usermod -aG "$ADMIN_GROUP" ${name}`}
${
	input.sudo === "nopasswd"
		? `printf '%s ALL=(ALL) NOPASSWD:ALL\\n' ${name} | $SUDO tee ${sudoersFile(name)} >/dev/null
$SUDO chmod 440 ${sudoersFile(name)}
$SUDO visudo -cf ${sudoersFile(name)} >/dev/null || { $SUDO rm -f ${sudoersFile(name)}; echo "ERROR sudoers rule rejected" >&2; exit 4; }`
		: ""
}
echo "OK created ${name}"`);
};

export const setKeysScript = (name: string, publicKeys: string[]) => {
	validateUsername(name);
	return script(`set -e
home=$(getent passwd ${name} | cut -d: -f6)
[ -n "$home" ] || { echo "ERROR no user ${name}" >&2; exit 3; }
printf '%s\\n' ${literal(publicKeys.join("\n"))} | as_user ${name} sh -c "$WRITE_KEYS" _ "$home"
echo "OK keys set for ${name}"`);
};

// Expiring the account blocks key logins too; locking the password alone
// would leave SSH keys working.
export const lockUserScript = (name: string, locked: boolean) => {
	validateUsername(name);
	return script(
		locked
			? `set -e\n$SUDO usermod --lock --expiredate 1 ${name}\necho "OK locked ${name}"`
			: // A key-only account has no password to unlock; clearing the
				// expiry is what lets it log in again.
				`set -e\n$SUDO usermod --expiredate '' ${name}\n$SUDO usermod --unlock ${name} 2>/dev/null || true\necho "OK unlocked ${name}"`,
	);
};

export const deleteUserScript = (name: string, removeHome: boolean) => {
	validateUsername(name);
	return script(`set -e
$SUDO pkill -KILL -u ${name} 2>/dev/null || true
$SUDO userdel ${removeHome ? "--remove " : ""}${name}
$SUDO rm -f ${sudoersFile(name)}
echo "OK deleted ${name}"`);
};

/**
 * Restarting sshd with a bad config locks everyone out, so every change is
 * tested first and a timer puts the old config back unless Dokploy can log
 * in again and cancel it.
 */
const restartSshWithSafetyNet = (revert: string) => `if ! $SUDO sshd -t; then
	${revert}
	echo "ERROR sshd rejected the new configuration; nothing was changed" >&2
	exit 5
fi
$SUDO systemctl stop ${REVERT_UNIT}.timer 2>/dev/null || true
$SUDO systemctl reset-failed ${REVERT_UNIT}.service 2>/dev/null || true
if ! $SUDO systemd-run --quiet --on-active=180 --unit=${REVERT_UNIT} sh -c ${shellQuote(`${revert.replaceAll("$SUDO ", "")}; systemctl daemon-reload; systemctl restart ssh.socket 2>/dev/null; systemctl restart ssh 2>/dev/null || systemctl restart sshd`)}; then
	${revert}
	echo "ERROR could not arm the automatic undo, so SSH was not restarted" >&2
	exit 6
fi
$SUDO systemctl daemon-reload
if $SUDO systemctl is-active --quiet ssh.socket; then $SUDO systemctl restart ssh.socket; fi
$SUDO systemctl restart ssh 2>/dev/null || $SUDO systemctl restart sshd
echo "PENDING_CONFIRM"`;

/** After a restart that should open a port: undo at once when nothing listens. */
const expectListening = (port: number, revert: string) => `sleep 2
if ! $SUDO ss -tlnH "sport = :${port}" | grep -q .; then
	${revert}
	$SUDO systemctl daemon-reload
	if $SUDO systemctl is-active --quiet ssh.socket; then $SUDO systemctl restart ssh.socket; fi
	$SUDO systemctl restart ssh 2>/dev/null || $SUDO systemctl restart sshd
	echo "ERROR SSH restarted but nothing listens on port ${port}; the change was undone" >&2
	exit 8
fi`;

/** Run from a fresh connection after a restart: proves SSH still works. */
export const confirmSshScript = () =>
	script(`$SUDO systemctl stop ${REVERT_UNIT}.timer 2>/dev/null || true
$SUDO systemctl stop ${REVERT_UNIT}.service 2>/dev/null || true
echo "OK confirmed"`);

export type RescueStatus = {
	userExists: boolean;
	port: number | null;
	managed: boolean;
	sshPorts: number[];
	firewall: "ufw" | "none";
};

export const rescueStatusScript = () =>
	script(`exists=0; id ${RESCUE_USER} >/dev/null 2>&1 && exists=1
managed=0; [ -f ${RESCUE_DROP_IN} ] && managed=1
port=$($SUDO grep -rhoiE '^Match LocalPort [0-9]+' /etc/ssh/sshd_config.d/ 2>/dev/null | head -1 | awk '{print $3}')
# With a Match block in the config, sshd -T only prints when given a
# connection to evaluate; the port list is global, so any connection will do.
ports=$({ $SUDO sshd -T -C user=root,host=localhost,addr=127.0.0.1,laddr=127.0.0.1,lport=1 2>/dev/null || $SUDO sshd -T 2>/dev/null; } | awk '/^port /{print $2}' | tr '\\n' ',')
fw=none; $SUDO ufw status 2>/dev/null | grep -q '^Status: active' && fw=ufw
printf 'RESCUE\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$exists" "\${port:-}" "$managed" "$ports" "$fw"`);

export const parseRescueStatus = (stdout: string): RescueStatus => {
	const line = stdout.split("\n").find((entry) => entry.startsWith("RESCUE\t"));
	const [, exists, port, managed, ports, firewall] = (line ?? "").split("\t");
	return {
		userExists: exists === "1",
		port: port ? Number(port) : null,
		managed: managed === "1",
		sshPorts: (ports ?? "")
			.split(",")
			.filter(Boolean)
			.map(Number)
			.filter(Number.isFinite),
		firewall: firewall === "ufw" ? "ufw" : "none",
	};
};

export const validateRescuePort = (port: number, sshPorts: number[]) => {
	if (!Number.isInteger(port) || port < 1024 || port > 65535) {
		throw new Error("Pick a port between 1024 and 65535");
	}
	if (sshPorts.includes(port)) {
		throw new Error("That port is already SSH's normal port");
	}
	return port;
};

/**
 * A password login that works without the mesh, on its own port, for the
 * rescue user only; that user is refused on every other port.
 */
export const enableRescueScript = (input: {
	port: number;
	password: string;
	publicKeys: string[];
	sshPorts: number[];
}) => {
	const sshPorts = input.sshPorts.length ? input.sshPorts : [22];
	// Key and password both: one leaked secret is not enough to get in.
	const match = `Match LocalPort ${input.port}
    AllowUsers ${RESCUE_USER}
    AuthenticationMethods publickey,password
    PasswordAuthentication yes
    KbdInteractiveAuthentication yes
    PermitRootLogin no
    MaxAuthTries 3
    AllowTcpForwarding no
    AllowAgentForwarding no
    X11Forwarding no
Match User ${RESCUE_USER} LocalPort ${sshPorts.join(",")}
    DenyUsers ${RESCUE_USER}`;
	// The first Port line anywhere replaces sshd's implicit 22, so the ports
	// SSH listens on now are listed again unless a file already names them.
	return script(`set -e
# A hand-written ssh.socket (ListenStream overrides) ignores Port lines, so
# the rescue port would never listen; such hosts manage rescue themselves.
if ls /etc/systemd/system/ssh.socket.d/*.conf >/dev/null 2>&1 || systemctl list-unit-files 2>/dev/null | grep -q '^ssh-.*\\.socket'; then
	echo "ERROR this server's SSH sockets are configured by hand; set up the rescue login with the tooling that manages them" >&2
	exit 7
fi
id ${RESCUE_USER} >/dev/null 2>&1 || $SUDO useradd --create-home --shell /bin/bash ${RESCUE_USER}
printf '%s:%s\n' ${RESCUE_USER} ${literal(input.password)} | $SUDO chpasswd
# No sudo: from rescue, root is one su - (and the root password) away.
$SUDO usermod --unlock --expiredate '' ${RESCUE_USER}
for group in sudo wheel admin docker adm; do $SUDO gpasswd -d ${RESCUE_USER} "$group" >/dev/null 2>&1 || true; done
home=$(getent passwd ${RESCUE_USER} | cut -d: -f6)
printf '%s\n' ${literal(input.publicKeys.join("\n"))} | as_user ${RESCUE_USER} sh -c "$WRITE_KEYS" _ "$home"
if [ -f ${RESCUE_DROP_IN} ]; then $SUDO cp ${RESCUE_DROP_IN} ${RESCUE_BACKUP}; else $SUDO rm -f ${RESCUE_BACKUP}; fi
next=$(mktemp)
echo "# Managed by Dokploy: emergency login for ${RESCUE_USER} on port ${input.port}." > "$next"
for p in ${sshPorts.join(" ")}; do
	$SUDO grep -rqsE --exclude=$(basename ${RESCUE_DROP_IN}) "^[[:space:]]*Port[[:space:]]+$p([[:space:]]|$)" /etc/ssh/sshd_config /etc/ssh/sshd_config.d/ || echo "Port $p" >> "$next"
done
echo "Port ${input.port}" >> "$next"
printf '%s\n' ${literal(match)} >> "$next"
$SUDO install -m 644 "$next" ${RESCUE_DROP_IN}
rm -f "$next"
if $SUDO ufw status 2>/dev/null | grep -q '^Status: active'; then
	$SUDO ufw allow ${input.port}/tcp comment 'rescue login (Dokploy)' >/dev/null
fi
set +e
${restartSshWithSafetyNet(`if [ -f ${RESCUE_BACKUP} ]; then $SUDO cp ${RESCUE_BACKUP} ${RESCUE_DROP_IN}; else $SUDO rm -f ${RESCUE_DROP_IN}; fi`)}
${expectListening(input.port, `if [ -f ${RESCUE_BACKUP} ]; then $SUDO cp ${RESCUE_BACKUP} ${RESCUE_DROP_IN}; else $SUDO rm -f ${RESCUE_DROP_IN}; fi`)}`);
};

export const rotateRescuePasswordScript = (password: string) =>
	script(`set -e
id ${RESCUE_USER} >/dev/null 2>&1 || { echo "ERROR there is no rescue user" >&2; exit 3; }
printf '%s:%s\\n' ${RESCUE_USER} ${literal(password)} | $SUDO chpasswd
echo "OK rotated"`);

export const disableRescueScript = (port: number | null) =>
	script(`$SUDO cp ${RESCUE_DROP_IN} ${RESCUE_BACKUP} 2>/dev/null || true
$SUDO rm -f ${RESCUE_DROP_IN}
${port ? `$SUDO ufw delete allow ${port}/tcp >/dev/null 2>&1 || true` : ""}
$SUDO usermod --lock --expiredate 1 ${RESCUE_USER} 2>/dev/null || true
${restartSshWithSafetyNet(`$SUDO cp ${RESCUE_BACKUP} ${RESCUE_DROP_IN}`)}`);

export type HostCommand = {
	id: string;
	label: string;
	description: string;
	/** read: changes nothing. change: restarts or cleans. danger: interrupts the server. */
	risk: "read" | "change" | "danger";
	script: string;
};

export const HOST_COMMANDS: HostCommand[] = [
	{
		id: "disk",
		label: "Disk usage",
		description: "Space left on each filesystem.",
		risk: "read",
		script: "df -h -x tmpfs -x devtmpfs -x overlay",
	},
	{
		id: "memory",
		label: "Memory and load",
		description: "Free memory, swap and load average.",
		risk: "read",
		script: "free -h; echo; uptime",
	},
	{
		id: "top",
		label: "Busiest processes",
		description: "The ten processes using the most CPU.",
		risk: "read",
		script: "ps -eo pid,user,%cpu,%mem,etime,comm --sort=-%cpu | head -11",
	},
	{
		id: "ports",
		label: "Listening ports",
		description: "What accepts connections on this server.",
		risk: "read",
		script: "$SUDO ss -tulpn",
	},
	{
		id: "failed",
		label: "Failed services",
		description: "systemd units that are not running when they should be.",
		risk: "read",
		script: "systemctl --failed --no-pager",
	},
	{
		id: "logins",
		label: "Recent logins",
		description:
			"Who logged in lately, and failed SSH attempts in the last day.",
		risk: "read",
		script:
			"last -n 15 2>/dev/null; echo; $SUDO journalctl -u ssh -u sshd --since '24 hours ago' --no-pager 2>/dev/null | grep -iE 'failed|invalid' | tail -20",
	},
	{
		id: "firewall",
		label: "Firewall status",
		description: "Current ufw rules.",
		risk: "read",
		script:
			"$SUDO ufw status verbose 2>/dev/null || echo 'ufw is not installed'",
	},
	{
		id: "docker",
		label: "Docker summary",
		description: "Running containers and disk used by Docker.",
		risk: "read",
		script:
			"$SUDO docker ps --format 'table {{.Names}}\\t{{.Status}}' | head -40; echo; $SUDO docker system df",
	},
	{
		id: "restart-docker",
		label: "Restart Docker",
		description: "Every container on this server restarts.",
		risk: "danger",
		script: "$SUDO systemctl restart docker && echo 'Docker restarted'",
	},
	{
		id: "docker-prune",
		label: "Clean up Docker",
		description:
			"Removes stopped containers, unused images and build cache. Volumes are kept.",
		risk: "change",
		script:
			"$SUDO docker system prune -af --filter 'until=24h' && $SUDO docker builder prune -af",
	},
	{
		id: "journal-vacuum",
		label: "Shrink system logs",
		description: "Keeps the last 200 MB of the journal.",
		risk: "change",
		script: "$SUDO journalctl --vacuum-size=200M",
	},
	{
		id: "reboot",
		label: "Reboot",
		description: "The server goes down for a minute or two.",
		risk: "danger",
		script:
			"$SUDO systemd-run --on-active=5 systemctl reboot && echo 'Rebooting in 5 seconds'",
	},
];

export const hostCommandScript = (id: string) => {
	const command = HOST_COMMANDS.find((entry) => entry.id === id);
	if (!command) throw new Error("Unknown command");
	return script(command.script);
};
