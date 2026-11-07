const bodyParser = require("body-parser");
const handler = require("../api/sait-za-20");

module.exports = function (app) {
  app.post(
    "/api/sait-za-20",
    bodyParser.json({ limit: "64kb" }),
    (req, res, next) => {
      Promise.resolve(handler(req, res)).catch(next);
    }
  );
};
