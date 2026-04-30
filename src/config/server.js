import process from "node:process";

const port = parseInt(process.env.ENGINE_PORT || "3000", 10);
if (isNaN(port) || port <= 0) {
  throw new Error("ENGINE_PORT must be a positive integer");
}
const host = process.env.ENGINE_HOST || "127.0.0.1";

export const SERVER_CONFIG = {
  port,
  host,
};
