// Tiny echo origin for the bash E2E runner (termux/e2e.sh).
// Usage: node tests/echo-origin.js [port]   (default 18787)
const http = require("node:http");

const port = Number(process.argv[2] || 18787);

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c.toString()));
  req.on("end", () => {
    if (req.url === "/boom") {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "boom" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        path: req.url,
        user: req.headers["x-proxy-user"] || null,
        tier: req.headers["x-proxy-tier"] || null,
        reqId: req.headers["x-request-id"] || null,
        body,
      }),
    );
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`echo-origin listening on :${port}`);
});
