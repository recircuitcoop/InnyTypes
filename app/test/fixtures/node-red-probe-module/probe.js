// Planted in userDir/node_modules by the WI-0018-08 e2e. Loading it would leave a marker file
// beside it and register the type `inny-probe`; the palette lock must prevent both.
"use strict";

const fs = require("node:fs");
const path = require("node:path");

module.exports = function (RED) {
  fs.writeFileSync(path.join(__dirname, "LOADED"), "the palette lock let a planted module load");
  RED.nodes.registerType("inny-probe", function (config) {
    RED.nodes.createNode(this, config);
  });
};
