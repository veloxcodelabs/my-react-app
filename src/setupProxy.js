const bodyParser = require("body-parser");

module.exports = function (app) {
  app.post(
    "/api/sait-za-20",
    bodyParser.json({ limit: "4mb" }),
    (req, res, next) => {
      import("../api/sait-za-20.mjs")
        .then((mod) => mod.default(req, res))
        .catch(next);
    }
  );
};
