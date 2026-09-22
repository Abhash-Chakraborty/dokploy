/**
 * Playbooks Dokploy ships with. They are stored as strings rather than read
 * from disk so they survive bundling, and they are exposed as a read-only
 * project named "Dokploy platform".
 */

export const PLATFORM_PROJECT = "Dokploy platform";

const BASELINE = `- name: Dokploy server baseline
  hosts: dokploy
  gather_facts: true
  vars:
    dokploy_install_packages: true
    dokploy_harden_ssh: true
    dokploy_ssh_port: 22
    dokploy_tune_kernel: true
  tasks:
    # One half-configured package fails every later apt transaction, including
    # ones that have nothing to do with it, and the error names whatever was
    # being installed at the time rather than the package actually at fault.
    # On a healthy host this does nothing.
    # Ubuntu 24.04 runs sshd socket-activated, so /run/sshd only exists while
    # ssh.service does. Without it the openssh-server postinst cannot restart
    # sshd, dpkg stops half way, and every apt run after that fails.
    - name: Make sure sshd can be restarted by package scripts
      ansible.builtin.file:
        path: /run/sshd
        state: directory
        mode: "0755"
      when:
        - dokploy_install_packages | bool
        - ansible_os_family == "Debian"

    # A unit that cannot start (ssh.socket losing its port to a stale sshd is
    # the usual one) makes the package's postinst fail, and dpkg gives up
    # half way. Clearing the failed state lets systemd try it again.
    - name: Clear a failed ssh.socket
      ansible.builtin.command: systemctl reset-failed ssh.socket
      changed_when: false
      failed_when: false
      when:
        - dokploy_install_packages | bool
        - ansible_service_mgr == "systemd"

    # policy-rc.d holds service restarts back for the length of the repair
    # only. Without it a service that refuses to start keeps dpkg broken, and
    # every later apt run fails on a package that has nothing to do with it.
    # Anything skipped here reads its config when it next starts anyway.
    - name: Repair a half-configured package state
      when:
        - dokploy_install_packages | bool
        - ansible_os_family == "Debian"
      block:
        # Some hosts ship their own policy (container images all do), and it
        # is theirs to keep: set it aside rather than overwrite it.
        - name: Keep the host's own restart policy aside
          ansible.builtin.command:
            cmd: mv /usr/sbin/policy-rc.d /usr/sbin/policy-rc.d.dokploy-kept
            removes: /usr/sbin/policy-rc.d
            creates: /usr/sbin/policy-rc.d.dokploy-kept
          changed_when: true

        - name: Hold service restarts back for the repair
          ansible.builtin.copy:
            dest: /usr/sbin/policy-rc.d
            mode: "0755"
            content: |
              #!/bin/sh
              exit 101

        - name: Configure whatever was left half done
          ansible.builtin.command: dpkg --configure -a
          environment:
            DEBIAN_FRONTEND: noninteractive
          register: dokploy_dpkg_repair
          changed_when: dokploy_dpkg_repair.stdout | trim | length > 0
          failed_when: false
      always:
        # Leaving ours behind would silently stop every service from starting.
        - name: Let services start again
          ansible.builtin.file:
            path: /usr/sbin/policy-rc.d
            state: absent

        - name: Put the host's own restart policy back
          ansible.builtin.command:
            cmd: mv /usr/sbin/policy-rc.d.dokploy-kept /usr/sbin/policy-rc.d
            removes: /usr/sbin/policy-rc.d.dokploy-kept
          changed_when: true

    - name: Report what the repair fixed
      ansible.builtin.debug:
        msg: "{{ dokploy_dpkg_repair.stdout_lines | default([]) }}"
      when:
        - dokploy_install_packages | bool
        - ansible_os_family == "Debian"
        - dokploy_dpkg_repair.stdout | default("") | trim | length > 0

    # A stale package index points at versions the mirrors have since
    # replaced, and the download 404s.
    - name: Install the basics
      ansible.builtin.apt:
        update_cache: true
        cache_valid_time: 3600
        name:
          # apt-utils first, or debconf defers every package's configuration
          # and says so on each run.
          - apt-utils
          - curl
          - ca-certificates
          - unattended-upgrades
          - fail2ban
          - chrony
        state: present
      environment:
        DEBIAN_FRONTEND: noninteractive
      when:
        - dokploy_install_packages | bool
        - ansible_os_family == "Debian"

    - name: Keep unattended upgrades on
      ansible.builtin.copy:
        dest: /etc/apt/apt.conf.d/20dokploy-unattended
        mode: "0644"
        content: |
          APT::Periodic::Update-Package-Lists "1";
          APT::Periodic::Unattended-Upgrade "1";
      when: ansible_os_family == "Debian"

    # Written as a drop-in and validated, so a mistake cannot lock anyone out.
    - name: Harden sshd
      ansible.builtin.copy:
        dest: /etc/ssh/sshd_config.d/10-dokploy.conf
        mode: "0644"
        validate: /usr/sbin/sshd -t -f %s
        content: |
          PermitRootLogin prohibit-password
          PasswordAuthentication no
          KbdInteractiveAuthentication no
          X11Forwarding no
          MaxAuthTries 4
          ClientAliveInterval 120
      when: dokploy_harden_ssh | bool
      notify: reload sshd

    - name: Tune the kernel for containers
      ansible.builtin.copy:
        dest: /etc/sysctl.d/60-dokploy.conf
        mode: "0644"
        content: |
          vm.swappiness = 10
          vm.max_map_count = 262144
          fs.inotify.max_user_instances = 1024
          fs.inotify.max_user_watches = 524288
          net.core.somaxconn = 4096
      when: dokploy_tune_kernel | bool
      register: dokploy_sysctl

    - name: Apply the kernel settings now
      ansible.builtin.command: sysctl --system
      when: dokploy_sysctl is changed
      changed_when: true

    # A host that has never had a drop-in has no directory for one, and copy
    # does not create parent directories.
    - name: Make room for the journal settings
      ansible.builtin.file:
        path: /etc/systemd/journald.conf.d
        state: directory
        mode: "0755"
      when: ansible_service_mgr == "systemd"

    - name: Cap the journal so logs cannot fill the disk
      ansible.builtin.copy:
        dest: /etc/systemd/journald.conf.d/10-dokploy.conf
        mode: "0644"
        content: |
          [Journal]
          SystemMaxUse=1G
          MaxRetentionSec=1month
      when: ansible_service_mgr == "systemd"
      notify: restart journald

  handlers:
    # With socket activation ssh.service is usually inactive, reload fails,
    # and each new connection reads the config anyway.
    - name: reload sshd
      ansible.builtin.shell: systemctl is-active --quiet ssh && systemctl reload ssh || true
      changed_when: true
      when: ansible_service_mgr == "systemd"

    - name: restart journald
      ansible.builtin.service:
        name: systemd-journald
        state: restarted
      when: ansible_service_mgr == "systemd"
`;

const CLEANUP = `- name: Reclaim disk on Dokploy servers
  hosts: dokploy
  # The journal step needs ansible_service_mgr, which is in the minimal set.
  gather_facts: true
  gather_subset:
    - "!all"
    - min
  vars:
    dokploy_prune_images_hours: 168
    dokploy_prune_volumes: false
  tasks:
    # A server set up without Docker still gets its journal and disk report.
    - name: Look for Docker
      ansible.builtin.command: sh -c "command -v docker"
      register: dokploy_docker
      failed_when: false
      changed_when: false

    - name: Prune stopped containers, old images and build cache
      ansible.builtin.command:
        cmd: docker system prune --force --filter "until={{ dokploy_prune_images_hours }}h"
      when: dokploy_docker.rc == 0
      register: dokploy_prune
      changed_when: "'Total reclaimed space: 0B' not in dokploy_prune.stdout"

    - name: Prune unused volumes
      ansible.builtin.command: docker volume prune --force
      when:
        - dokploy_docker.rc == 0
        - dokploy_prune_volumes | bool
      register: dokploy_volume_prune
      changed_when: "'Total reclaimed space: 0B' not in dokploy_volume_prune.stdout"

    - name: Vacuum the journal
      ansible.builtin.command: journalctl --vacuum-size=500M
      when: ansible_service_mgr == "systemd"
      changed_when: false

    - name: Report what is left
      ansible.builtin.command: df -h /
      register: dokploy_disk
      changed_when: false

    - name: Show it
      ansible.builtin.debug:
        msg: "{{ dokploy_disk.stdout_lines }}"
`;

const UPDATES = `- name: Patch Dokploy servers
  hosts: dokploy
  serial: "{{ dokploy_batch | default(1) }}"
  gather_facts: true
  vars:
    dokploy_reboot: true
  tasks:
    - name: Make sure sshd can be restarted by package scripts
      ansible.builtin.file:
        path: /run/sshd
        state: directory
        mode: "0755"
      when: ansible_os_family == "Debian"

    - name: Clear a failed ssh.socket
      ansible.builtin.command: systemctl reset-failed ssh.socket
      changed_when: false
      failed_when: false
      when: ansible_service_mgr == "systemd"

    # Same repair as the baseline: one package left half-configured by an
    # earlier run fails every upgrade after it, and it stays that way while
    # the service its postinst restarts cannot start.
    - name: Repair a half-configured package state
      when: ansible_os_family == "Debian"
      block:
        - name: Keep the host's own restart policy aside
          ansible.builtin.command:
            cmd: mv /usr/sbin/policy-rc.d /usr/sbin/policy-rc.d.dokploy-kept
            removes: /usr/sbin/policy-rc.d
            creates: /usr/sbin/policy-rc.d.dokploy-kept
          changed_when: true

        - name: Hold service restarts back for the repair
          ansible.builtin.copy:
            dest: /usr/sbin/policy-rc.d
            mode: "0755"
            content: |
              #!/bin/sh
              exit 101

        - name: Configure whatever was left half done
          ansible.builtin.command: dpkg --configure -a
          environment:
            DEBIAN_FRONTEND: noninteractive
          register: dokploy_dpkg_repair
          changed_when: dokploy_dpkg_repair.stdout | trim | length > 0
          failed_when: false
      always:
        - name: Let services start again
          ansible.builtin.file:
            path: /usr/sbin/policy-rc.d
            state: absent

        - name: Put the host's own restart policy back
          ansible.builtin.command:
            cmd: mv /usr/sbin/policy-rc.d.dokploy-kept /usr/sbin/policy-rc.d
            removes: /usr/sbin/policy-rc.d.dokploy-kept
          changed_when: true

    - name: Update the package lists and upgrade
      ansible.builtin.apt:
        update_cache: true
        upgrade: safe
        autoremove: true
      environment:
        DEBIAN_FRONTEND: noninteractive
      when: ansible_os_family == "Debian"

    - name: Does it need a reboot?
      ansible.builtin.stat:
        path: /var/run/reboot-required
      register: dokploy_reboot_required

    - name: Reboot and wait for it to come back
      ansible.builtin.reboot:
        reboot_timeout: 600
      when:
        - dokploy_reboot | bool
        - dokploy_reboot_required.stat.exists
`;

export const PLATFORM_FILES: Record<string, string> = {
	"baseline.yml": BASELINE,
	"cleanup.yml": CLEANUP,
	"updates.yml": UPDATES,
	"ping.yml": `- name: Check Dokploy can reach these servers
  hosts: dokploy
  gather_facts: true
  tasks:
    - name: Report what we found
      ansible.builtin.debug:
        msg: "{{ inventory_hostname }}: {{ ansible_distribution }} {{ ansible_distribution_version }}"
`,
};
