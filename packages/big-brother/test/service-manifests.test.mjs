import test from "node:test";
import assert from "node:assert/strict";

import { renderLaunchdPlist, renderSystemdUnit } from "../src/index.mjs";

const serviceOptions = {
	label: "com.big-brother.watch",
	executable: "/Users/m1zu/ws/Big Brother/bin/big-brother",
	configPath: "/Users/m1zu/ws/Big Brother/config/big-brother.json",
	workingDirectory: "/Users/m1zu/ws/Big Brother",
	envFile: "/Users/m1zu/.config/big-brother/env",
	path: "/Users/m1zu/.nvm/versions/node/v24.19.0/bin:/usr/bin:/bin",
	restartSeconds: 15,
};

test("launchd manifest runs foreground watch with explicit paths and restart policy", () => {
	const plist = renderLaunchdPlist(serviceOptions);

	assert.match(plist, /<key>Label<\/key>\s*<string>com\.big-brother\.watch<\/string>/);
	assert.match(plist, /<key>ProgramArguments<\/key>/);
	assert.match(plist, /<string>watch<\/string>/);
	assert.match(plist, /<string>--config<\/string>/);
	assert.match(plist, /Big Brother\/bin\/big-brother/);
	assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
	assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>15<\/integer>/);
	assert.match(plist, /BIG_BROTHER_ENV_FILE/);
	assert.match(plist, /<key>PATH<\/key>/);
	assert.match(plist, /v24\.19\.0\/bin/);
	assert.match(plist, /Big Brother\/config\/big-brother\.json/);
});

test("systemd unit keeps watch in the foreground and restarts failures", () => {
	const unit = renderSystemdUnit(serviceOptions);

	assert.match(unit, /Type=simple/);
	assert.match(unit, /ExecStart=.*watch.*--config/);
	assert.match(unit, /Restart=on-failure/);
	assert.match(unit, /RestartSec=15/);
	assert.match(unit, /WorkingDirectory=\/Users\/m1zu\/ws\/Big\\x20Brother/);
	assert.match(unit, /Environment=BIG_BROTHER_ENV_FILE=\/Users\/m1zu\/\.config\/big-brother\/env/);
	assert.match(unit, /Environment=PATH=\/Users\/m1zu\/\.nvm\/versions\/node\/v24\.19\.0\/bin:\/usr\/bin:\/bin/);
});

test("service manifest renderers reject relative paths and invalid restart values", () => {
	assert.throws(
		() => renderLaunchdPlist({ ...serviceOptions, configPath: "config/big-brother.json" }),
		/absolute path/,
	);
	assert.throws(
		() => renderSystemdUnit({ ...serviceOptions, restartSeconds: 0 }),
		/restartSeconds/,
	);
});

test("service manifest renderers provide stable defaults", () => {
	const unit = renderSystemdUnit({
		executable: "/srv/big-brother/bin/big-brother",
		configPath: "/srv/big-brother/config.json",
		workingDirectory: "/srv/big-brother",
		envFile: "/etc/big-brother/env",
	});

	assert.match(unit, /repository watch service \(com\.big-brother\.watch\)/);
	assert.match(unit, /RestartSec=10/);
});
