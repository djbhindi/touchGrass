/** SSL options for `live-server --https=live-server-https.js` (reuses project PEMs). */
const fs = require("fs");
const path = require("path");

const root = __dirname;

module.exports = {
  cert: fs.readFileSync(path.join(root, "cert.pem")),
  key: fs.readFileSync(path.join(root, "key.pem")),
};
