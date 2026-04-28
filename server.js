const express = require("express");
const axios = require("axios");
const cron = require("node-cron");
const cors = require("cors");
const mongoose = require("mongoose");

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
app.use(express.static("public"));

/* ===== CONNECT MONGO ===== */
mongoose.connect(process.env.MONGO_URI)
.then(() => console.log("✅ MongoDB connected"))
.catch(err => console.error("❌ MongoDB error:", err));

/* ===== SCHEMA ===== */
const HistorySchema = new mongoose.Schema({
  time: String, // Lưu ISO String: 2026-04-28T02:00:00Z
  date: String, 
  usd: Number,
  xau: Number,
  sjc: Number,
  worldVND: Number,
  diff: Number,
  percent: String
}, { timestamps: true });

const History = mongoose.model("History", HistorySchema);
let latestData = null;

/* ===== HELPERS ===== */
function getTodayVN() {
  return new Date(new Date().getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/* ===== FETCH SJC (Dòng 1, Cột 3) ===== */
async function getSJCPrice() {
  try {
    const res = await axios.get("https://sjc.com.vn/gia-vang-online", { timeout: 10000 });
    // Tìm các cụm số có dạng xx.xxx hoặc xxx.xxx (SJC niêm yết đơn vị nghìn đồng)
    const matches = res.data.match(/[0-9]{2,3}\.[0-9]{3}/g);
    if (matches && matches.length >= 2) {
      // Dòng 1: Mua (index 0), Bán (index 1)
      const rawPrice = matches[1].replace(/\./g, "");
      return parseInt(rawPrice) * 1000; 
    }
    return 85000000;
  } catch (e) { return 85000000; }
}

async function getUSDRate() {
  try {
    const res = await axios.get("https://webgia.com/ty-gia/vietcombank/");
    const nums = res.data.match(/[0-9]{2}\.[0-9]{3},[0-9]{2}/g);
    const values = nums.map(n => parseFloat(n.replace(/\./g, "").replace(",", ".")));
    return Math.max(...values.filter(v => v > 24000));
  } catch { return 25450; }
}

async function getWorldGoldPrice() {
  try {
    const res = await axios.get("https://api.gold-api.com/price/XAU");
    return res.data.price || 2350;
  } catch { return 2350; }
}

/* ===== UPDATE & SAVE ===== */
async function updateData() {
  try {
    const [usd, xau, sjc] = await Promise.all([getUSDRate(), getWorldGoldPrice(), getSJCPrice()]);

    const worldVND = Math.round(xau * usd * (37.5 / 31.1035));
    const diff = sjc - worldVND;
    const percent = ((diff / worldVND) * 100).toFixed(2) + "%";

    latestData = {
      time: new Date().toISOString(), // LUÔN LƯU ISO CHUẨN
      date: getTodayVN(),
      usd, xau, sjc, worldVND, diff, percent
    };

    const last = await History.findOne().sort({ createdAt: -1 });
    if (!last || last.sjc !== sjc) {
      await History.create(latestData);
      console.log("💾 Saved SJC:", sjc);
    }
  } catch (e) { console.log("❌ Update error:", e.message); }
}

cron.schedule("*/2 * * * *", updateData);

app.get("/api/gold", (req, res) => res.json(latestData || {}));
app.get("/api/history", async (req, res) => {
  const data = await History.find().sort({ createdAt: -1 }).limit(100);
  res.json(data);
});
app.delete("/api/history", async (req, res) => {
  await History.deleteMany({});
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log("🚀 Server running on", PORT);
  updateData();
});