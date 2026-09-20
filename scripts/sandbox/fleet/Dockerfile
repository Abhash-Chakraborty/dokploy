# A throwaway stand-in for a managed server: sshd, python for Ansible, and
# the firewall tools, in its own network namespace.
FROM ubuntu:24.04
ARG SANDBOX_ID=unknown
LABEL com.abhash.sandbox=$SANDBOX_ID

RUN apt-get update \
	&& DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
		openssh-server python3 python3-apt sudo iproute2 iptables ufw curl ca-certificates \
	&& rm -rf /var/lib/apt/lists/* \
	&& update-alternatives --set iptables /usr/sbin/iptables-nft \
	&& update-alternatives --set ip6tables /usr/sbin/ip6tables-nft \
	&& mkdir -p /run/sshd /root/.ssh \
	&& chmod 700 /root/.ssh \
	# StrictModes off: the authorized_keys file is bind-mounted from the
	# sandbox directory, so it is not owned by root inside the container.
	&& printf 'PermitRootLogin prohibit-password\nPasswordAuthentication no\nStrictModes no\n' \
		> /etc/ssh/sshd_config.d/00-sandbox.conf

CMD ["/usr/sbin/sshd", "-D", "-e"]
