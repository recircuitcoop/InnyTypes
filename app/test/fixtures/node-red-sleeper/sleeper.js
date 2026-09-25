// A hand-written Node-RED node file for the WI-0018-08 e2e, planted in the runtime's generated
// types folder before the app starts, until WI-0018-09 generates real ones.
//
// Each instance holds one long-running child process, as a real node instance does, and
// writes its pid to <userData>/pids/<node id>; closing the instance kills the process. Two
// types: one for a package in the store (the rawnode fixture), one for a package that is not.
"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// <userData>/node-red/generated/sleeper.js → <userData>/pids
const PIDS = path.join(__dirname, "..", "..", "pids");

module.exports = function (RED) {
  function Sleeper(config) {
    RED.nodes.createNode(this, config);
    const child = spawn("sleep", ["3600"], { stdio: "ignore" });
    const file = path.join(PIDS, this.id);
    fs.mkdirSync(PIDS, { recursive: true });
    fs.writeFileSync(file, String(child.pid));
    this.on("close", (_removed, done) => {
      child.kill("SIGKILL");
      fs.rmSync(file, { force: true });
      done();
    });
  }
  RED.nodes.registerType("inny-rawnode-sleeper", Sleeper);
  RED.nodes.registerType("inny-rogue-sleeper", Sleeper);
};
