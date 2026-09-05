export const UNIT_TEMPLATES: Record<string, string> = {
	"open-mcc@.service": `[Unit]
Description=open-mcc-manager instance %i
StartLimitIntervalSec=600
StartLimitBurst=5
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=mcc-%i
Group=mcc-%i
WorkingDirectory=/srv/open-mcc/instances/%i
EnvironmentFile=/srv/open-mcc/instances/%i/env
ExecStart=/srv/open-mcc/bin/MinecraftClient BasicIO-NoColor
ExecStop=/bin/sh -c 'printf "/quit\\n" > /srv/open-mcc/instances/%i/control'
StandardInput=file:/srv/open-mcc/instances/%i/control
StandardOutput=journal
StandardError=journal
TimeoutStopSec=30
Restart=on-failure
RestartPreventExitStatus=4
RestartSec=30
NoNewPrivileges=yes
UMask=0077
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=/srv/open-mcc/instances/%i

[Install]
WantedBy=multi-user.target
`,
	"open-mcc-sleep-stop@.service": `[Unit]
Description=Stop open-mcc instance %i for its sleep window

[Service]
Type=oneshot
ExecStart=/usr/bin/systemctl stop open-mcc@%i.service
`,
	"open-mcc-sleep-start@.service": `[Unit]
Description=Start open-mcc instance %i after its sleep window

[Service]
Type=oneshot
ExecStart=/usr/bin/systemctl start open-mcc@%i.service
`,
}

export const UNIT_TEMPLATE = UNIT_TEMPLATES["open-mcc@.service"] ?? ""
