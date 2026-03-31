import { buildApp } from "./api/http.js";
import { config } from "./config.js";

const app = buildApp();

app.listen(config.port, () => {
  console.error(`API listening on :${config.port}`);
});
