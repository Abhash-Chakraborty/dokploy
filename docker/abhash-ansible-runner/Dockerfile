# The image every Ansible run, backup and restic job runs in. Dokploy itself
# never carries these tools: it starts a throwaway container instead.
FROM python:3.12-alpine3.20

ARG ANSIBLE_CORE_VERSION=2.19.3

RUN apk add --no-cache \
		openssh-client \
		sshpass \
		rsync \
		restic \
		rclone \
		git \
		ca-certificates \
	&& pip install --no-cache-dir "ansible-core==${ANSIBLE_CORE_VERSION}"

COPY requirements.yml /tmp/requirements.yml
RUN ansible-galaxy collection install -r /tmp/requirements.yml -p /usr/share/ansible/collections \
	&& rm /tmp/requirements.yml

# Runs unprivileged; the work directory is mounted in per run.
RUN adduser -D -u 10001 runner
USER runner
WORKDIR /work

ENV ANSIBLE_COLLECTIONS_PATH=/usr/share/ansible/collections \
	ANSIBLE_HOST_KEY_CHECKING=True \
	ANSIBLE_RETRY_FILES_ENABLED=False \
	ANSIBLE_STDOUT_CALLBACK=default \
	PYTHONUNBUFFERED=1

ENTRYPOINT ["ansible-playbook"]
