FROM debian:bookworm-20250908

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
