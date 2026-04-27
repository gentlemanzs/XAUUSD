const express = require("express");
const axios = require("axios");
const cron = require("node-cron");
const cors = require("cors");
const path = require("path");
const mongoose = require("mongoose");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;
const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ [Database] Connected"))
  .catch(err => console.error("❌ [Database] Error:", err.message));

const historySchema = new mongoose.Schema({
  time: String,
  usd: Number,
  xau: Number,
  sjc: Number,
  worldVND: Number,
  diff: Number,
  percent: String,
  createdAt: { type: Date, default: Date.now }
});
const History = mongoose.model("History", historySchema);

app.use(express.static("public"));
let latestData = null;

async function fetchWithRetry(url) {
  try {
    const res = await axios.get(url, { timeout: 10000, headers: { "User-Agent": "Mozilla/5.0" } });
    return res.data;
  } catch (e) { return null; }
}

/* 1. LẤY TỶ GIÁ USD (Vietcombank Bán ra) */
async function getUSDRate() {
  try {
    const html = await fetchWithRetry("https://webgia.com/ty-gia/vietcombank/");
    const clean = html.replace(/\s+/g, " ");
    const match = clean.match(/USD.*?([0-9]{2}\.[0-9]{3}).*?([0-9]{2}\.[0-9]{3}).*?([0-9]{2}\.[0-9]{3})/);
    return match ? parseFloat(match[3].replace(".", "")) : 26368;
  } catch (e) { return 26368; }
}

/* 2. LẤY GIÁ VÀNG THẾ GIỚI (USD/Ounce) */
async function getWorldGoldPrice() {
  try {
    const data = await fetchWithRetry("https://api.gold-api.com/price/XAU");
    return data?.price ? parseFloat(data.price) : 2350;
  } catch { return 2350; }
}

/* 3. LẤY GIÁ VÀNG SJC (VND/Lượng) */
async function getSJCPrice() {
  try {
    const html = await fetchWithRetry("https://webgia.com/gia-vang/sjc/");
    const clean = html.replace(/\s+/g, " ");
    const match = clean.match(/SJC TP\.HCM.*?([0-9]{2}\.[0-9]{3}\.[0-9]{3}).*?([0-9]{2}\.[0-9]{3}\.[0-9]{3})/);
    return match ? parseInt(match[2].replace(/\./g, "")) : 83000000;
  } catch (e) { return 83000000; }
}

/* --- LOGIC TÍNH TOÁN MARKET GAP CHUẨN --- */
async function updateData() {
  try {
    const usd = await getUSDRate();
    const xau = await getWorldGoldPrice();
    const sjc = await getSJCPrice();

    // CÔNG THỨC: 1 troy ounce = 0.82942 lượng -> 1 lượng = 1.20565 ounce
    // Giá thế giới quy đổi (VND/Lượng) = Giá thế giới (oz) * 1.20565 * Tỷ giá USD
    const worldVND = xau * 1.20565 * usd;
    
    // Chênh lệch (Gap) = Giá SJC - Giá thế giới quy đổi
    const diff = sjc - worldVND;
    
    // Phần trăm chênh lệch
    const percent = (diff / worldVND) * 100;

    latestData = {
      time: new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }),
      usd: Number(usd),
      xau: Number(xau),
      sjc: Number(sjc),
      worldVND: Math.round(worldVND),
      diff: Math.round(diff), // Con số này sẽ hiện ở ô Market Gap
      percent: percent.toFixed(2) + "%"
    };

    console.log(`[Tính toán] SJC: ${sjc} | TG Quy đổi: ${Math.round(worldVND)} | Gap: ${Math.round(diff)}`);

    // Lưu vào Database
    if (mongoose.connection.readyState === 1) {
      await History.create(latestData);
      const count = await History.countDocuments();
      if (count > 100) await History.findOneAndDelete({}, { sort: { createdAt: 1 } });
    }
  } catch (e) { console.error("Update Error:", e); }
}

cron.schedule("*/2 * * * *", updateData);

app.get("/api/gold", (req, res) => res.json(latestData || { message: "Wait..." }));
app.get("/api/history", async (req, res) => {
  const data = await History.find().sort({ createdAt: -1 }).limit(100);
  res.json(data.reverse());
});
app.delete("/api/history", async (req, res) => {
  await History.deleteMany({});
  res.json({ message: "Cleared" });
});
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public/index.html")));

app.listen(PORT, () => {
  console.log(`🚀 Server on port ${PORT}`);
  updateData();
});