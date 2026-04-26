const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

/* ===== FILE STORAGE ===== */
const DATA_FILE = path.join(__dirname, "data/history.json");

/* Ensure file exists */
if (!fs.existsSync(DATA_FILE)) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, "[]");
}

function readHistory() {
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function writeHistory(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

/* ===== FAKE DATA (TEST) ===== */
function generateData() {
  const usd = 26000;
  const xau = 4700 + Math.random() * 50;
  const sjc = 168000000 + Math.floor(Math.random() * 3000000);
  const world = xau * usd * (37.5 / 31.1035);
  const diff = sjc - world;
  const percent = ((diff / world) * 100).toFixed(2) + "%";

  return {
    usd,
    xau,
    sjc,
    worldVND: Math.round(world),
    diff: Math.round(diff),
    percent
  };
}

/* ===== API GOLD ===== */
app.get("/api/gold", (req, res) => {
  res.json(generateData());
});

/* ===== HISTORY ===== */
app.get("/api/history", (req, res) => {
  res.json(readHistory());
});

app.post("/api/history", (req, res) => {
  const history = readHistory();

  history.push(req.body);

  if (history.length > 100) history.shift();

  writeHistory(history);

  res.json({ ok: true });
});

app.delete("/api/history", (req, res) => {
  writeHistory([]);
  res.json({ ok: true });
});

/* ===== START ===== */
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
