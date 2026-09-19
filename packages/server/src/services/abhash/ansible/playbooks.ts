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
    - name: Install the basics
      ansible.builtin.package:
        name:
          - curl
          - ca-certificates
          - unattended-upgrades
          - fail2ban
          - chrony
        state: present
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
    - name: reload sshd
      ansible.builtin.service:
        name: ssh
        state: reloaded
      when: ansible_service_mgr == "systemd"

    - name: restart journald
      ansible.builtin.service:
        name: systemd-journald
        state: restarted
      when: ansible_service_mgr == "systemd"
`;

const CLEANUP = `- name: Reclaim disk on Dokploy servers
  hosts: dokploy
  gather_facts: false
  vars:
    dokploy_prune_images_hours: 168
    dokploy_prune_volumes: false
  tasks:
    - name: Prune stopped containers, old images and build cache
      ansible.builtin.command:
        cmd: docker system prune --force --filter "until={{ dokploy_prune_images_hours }}h"
      register: dokploy_prune
      changed_when: "'Total reclaimed space: 0B' not in dokploy_prune.stdout"

    - name: Prune unused volumes
      ansible.builtin.command: docker volume prune --force
      when: dokploy_prune_volumes | bool
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
    - name: Update the package lists and upgrade
      ansible.builtin.apt:
        update_cache: true
        upgrade: safe
        autoremove: true
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
