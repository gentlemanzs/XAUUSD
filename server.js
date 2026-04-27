const express = require("express");
const axios = require("axios");
const cron = require("node-cron");
const cors = require("cors");
const path = require("path");
const mongoose = require("mongoose");

const app = express();
app.use(cors());

/* ===== PORT ===== */
const PORT = process.env.PORT || 3000;

/* ===== SERVE FRONTEND ===== */
app.use(express.static("public"));

/* ===== CONNECT MONGODB ===== */
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error("❌ MongoDB error:", err));

/* ===== SCHEMA ===== */
const HistorySchema = new mongoose.Schema({
  time: String,
  usd: Number,
  xau: Number,
  sjc: Number,
  worldVND: Number,
  diff: Number,
  percent: String
}, { timestamps: true });

const History = mongoose.model("History", HistorySchema);

let latestData = null;

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
    const html = await fetchWithRetry("https://webgia.com/ty-gia/vietcombank/");
    if (!html) throw "Fetch fail";

    const clean = html.replace(/\s+/g, " ");
    const nums = clean.match(/[0-9]{2,3}\.[0-9]{3},[0-9]{2}/g);

    const values = nums.map(n =>
      parseFloat(n.replace(/\./g, "").replace(",", "."))
    );

    const usdValues = values.filter(v => v > 20000 && v < 30000);
    return Math.max(...usdValues);

  } catch {
    return 26000;
  }
}

/* ===== XAU ===== */
async function getWorldGoldPrice() {
  try {
    const data = await fetchWithRetry("https://api.gold-api.com/price/XAU");
    return data?.price || 2350;
  } catch {
    return 2350;
  }
}

/* ===== SJC ===== */
async function getSJCPrice() {
  return 168800000;
}

/* ===== SAVE HISTORY (MongoDB) ===== */
async function saveHistory(entry) {
  try {
    const last = await History.findOne().sort({ createdAt: -1 });

    if (!last || last.sjc !== entry.sjc || last.xau !== entry.xau) {
      await History.create(entry);
      console.log("💾 Saved to MongoDB");

      // Giữ tối đa 200 record
      const count = await History.countDocuments();
      if (count > 200) {
        const oldest = await History.findOne().sort({ createdAt: 1 });
        if (oldest) await History.deleteOne({ _id: oldest._id });
      }
    }
  } catch (e) {
    console.log("❌ Mongo save error:", e);
  }
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
      time: new Date().toLocaleString("vi-VN"),
      usd,
      xau,
      sjc,
      worldVND: Math.round(worldVND),
      diff: Math.round(diff),
      percent: percent.toFixed(2) + "%"
    };

    await saveHistory(latestData);
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

/* ===== HISTORY FROM MONGO ===== */
app.get("/api/history", async (req, res) => {
  try {
    const data = await History.find().sort({ createdAt: 1 });
    res.json(data);
  } catch {
    res.json([]);
  }
});

/* ===== DELETE HISTORY ===== */
app.delete("/api/history", async (req, res) => {
  await History.deleteMany({});
  res.json({ message: "Deleted" });
});

/* ===== ROOT ===== */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

/* ===== START ===== */
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  updateData();
});