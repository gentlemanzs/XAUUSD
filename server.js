const express = require("express");
const axios = require("axios");
const cron = require("node-cron");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const path = require("path");

const DATA_FILE = path.join(__dirname, "data/history.json");

/* READ FILE */
function readHistory(){
  try{
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  }catch{
    return [];
  }
}

/* WRITE FILE */
function writeHistory(data){
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}
const app = express();
app.use(cors());

/* 🔥 PORT FIX */
const PORT = process.env.PORT || 3000;

/* 🔥 SERVE FRONTEND */
app.use(express.static("public"));

let latestData = null;
/* GET */
app.get("/api/history", (req,res)=>{
  res.json(readHistory());
});

/* POST */
app.post("/api/history", express.json(), (req,res)=>{
  const history = readHistory();

  history.push(req.body);

  if(history.length > 100) history.shift();

  writeHistory(history);

  res.json({ ok:true });
});

/* DELETE */
app.delete("/api/history", (req,res)=>{
  writeHistory([]);
  res.json({ ok:true });
});
/* ===== CONFIG ===== */
const CONFIG = {
  TIMEOUT: 5000,
  RETRY: 2
};

/* ===== HELPER FETCH ===== */
async function fetchWithRetry(url) {
  for (let i = 0; i < CONFIG.RETRY; i++) {
    try {
      const res = await axios.get(url, {
        timeout: CONFIG.TIMEOUT,
        headers: { "User-Agent": "Mozilla/5.0" }
      });
      return res.data;
    } catch (e) {
      console.log(`⚠️ Retry ${i + 1} fail: ${url}`);
    }
  }
  return null;
}

/* ===== USD ===== */
async function getUSDRate() {
  try {
    console.log("🔎 Fetch USD từ webgia...");

    const html = await fetchWithRetry("https://webgia.com/ty-gia/vietcombank/");
    if (!html) throw "Fetch fail";

    const clean = html.replace(/\s+/g, " ");

    const nums = clean.match(/[0-9]{2,3}\.[0-9]{3},[0-9]{2}/g);

    if (!nums || nums.length === 0) throw "Không tìm thấy số";

    const values = nums.map(n =>
      parseFloat(n.replace(/\./g, "").replace(",", "."))
    );

    const usdValues = values.filter(v => v > 20000 && v < 30000);

    if (usdValues.length === 0) throw "Không có giá hợp lệ";

    return Math.max(...usdValues);

  } catch (e) {
    console.log("❌ USD fallback");
    return 26000;
  }
}

/* ===== XAU ===== */
async function getWorldGoldPrice() {
  try {
    const data = await fetchWithRetry("https://api.gold-api.com/price/XAU");

    if (data && data.price) return data.price;

    throw "API lỗi";
  } catch {
    return 2350;
  }
}

/* ===== SJC ===== */
async function getSJCPrice() {
  return 168800000;
}

/* ===== UPDATE ===== */
async function updateData() {
  console.log("\n⏳ Updating...");

  try {
    const usd = await getUSDRate();
    const xau = await getWorldGoldPrice();
    const sjc = await getSJCPrice();

    const worldVND = xau * usd * (37.5 / 31.1035);
    const diff = sjc - worldVND;
    const percent = (diff / worldVND) * 100;

    latestData = {
      time: new Date(),
      usd,
      xau,
      sjc,
      worldVND: Math.round(worldVND),
      diff: Math.round(diff),
      percent: percent.toFixed(2) + "%"
    };

    console.log("✅ DONE");

  } catch (e) {
    console.log("❌ UPDATE ERROR:", e);
  }
}

/* ===== CRON ===== */
cron.schedule("*/2 * * * *", updateData);

/* ===== API ===== */
app.get("/api/gold", (req, res) => {
  if (!latestData) {
    return res.json({ message: "No data yet, please wait..." });
  }
  res.json(latestData);
});

/* ===== ROOT (serve index.html) ===== */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

/* ===== START ===== */
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  updateData();
});
