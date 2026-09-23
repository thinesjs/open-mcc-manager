ARG BASE_IMAGE=debian:bookworm-20250908

FROM ${BASE_IMAGE} AS host

ENV container=docker

RUN apt-get update \
	&& DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
		dbus \
		dbus-user-session \
		libpam-systemd \
		openssh-server \
		sudo \
		systemd \
		systemd-sysv \
	&& rm -rf /var/lib/apt/lists/* /etc/ssh/ssh_host_*

COPY ssh-host-keys.conf /etc/systemd/system/ssh.service.d/host-keys.conf

RUN useradd --create-home --shell /bin/bash tester \
	&& printf 'tester ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/tester \
	&& chmod 440 /etc/sudoers.d/tester \
	&& systemctl mask getty@tty1.service console-getty.service systemd-firstboot.service systemd-sysctl.service systemd-binfmt.service systemd-modules-load.service \
	&& systemctl enable ssh.service

STOPSIGNAL SIGRTMIN+3

CMD ["/lib/systemd/systemd"]

FROM host AS podman-host

RUN apt-get update \
	&& major=$(apt-cache policy podman | awk '/Candidate:/ {print $2; exit}' | sed -E 's/^[0-9]+://; s/[^0-9].*$//') \
	&& helper=slirp4netns \
	&& if [ "$major" -ge 5 ]; then helper=passt; fi \
	&& DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends --no-remove \
		podman \
		uidmap \
		"$helper" \
		catatonit \
		dbus-user-session \
		fuse-overlayfs \
		ca-certificates \
		curl \
		iproute2 \
		procps \
		busybox-static \
	&& rm -rf /var/lib/apt/lists/* \
	&& systemctl mask podman.service podman.socket podman-restart.service podman-auto-update.service podman-auto-update.timer podman-clean-transient.service

RUN for n in 1 2 3 4 5 6; do \
		useradd --create-home --uid "$((2000 + n))" --shell /bin/bash "pod$n" \
		&& install -d -o "pod$n" -g "pod$n" -m 0755 "/home/pod$n/.local" "/home/pod$n/.local/share" \
		&& install -d -o "pod$n" -g "pod$n" -m 0700 "/home/pod$n/.local/share/containers" \
		|| exit 1; \
	done
