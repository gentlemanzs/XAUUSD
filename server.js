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
  .then(() => console.log("✅ MongoDB Atlas connected (Railway)"))
  .catch(err => {
    console.error("❌ MongoDB error:", err);
    process.exit(1);
  });

/* ===== SCHEMA ===== */
const HistorySchema = new mongoose.Schema({
  time: String, // Lưu ISO String (Vd: 2026-04-28T02:00:00Z)
  date: String, // Lưu yyyy-mm-dd theo giờ VN để filter
  usd: Number,
  xau: Number,
  sjc: Number,
  worldVND: Number,
  diff: Number,
  percent: String
}, { timestamps: true });

const History = mongoose.model("History", HistorySchema);

let latestData = null;

/* ===== HELPER: Lấy ngày yyyy-mm-dd theo giờ VN ===== */
function getTodayVN() {
  const now = new Date();
  // Cộng 7 tiếng để ép về giờ VN trước khi lấy chuỗi ngày
  const vnTime = new Date(now.getTime() + (7 * 60 * 60 * 1000));
  return vnTime.toISOString().slice(0, 10);
}

/* ===== FETCH LOGIC ===== */
async function getUSDRate() {
  try {
    const res = await axios.get("https://webgia.com/ty-gia/vietcombank/", { timeout: 5000 });
    const clean = res.data.replace(/\s+/g, " ");
    const nums = clean.match(/[0-9]{2,3}\.[0-9]{3},[0-9]{2}/g);
    const values = nums.map(n => parseFloat(n.replace(/\./g, "").replace(",", ".")));
    return Math.max(...values.filter(v => v > 20000 && v < 30000));
  } catch { return 25450; }
}

async function getWorldGoldPrice() {
  try {
    const res = await axios.get("https://api.gold-api.com/price/XAU", { timeout: 5000 });
    return res.data.price || 2350;
  } catch { return 2350; }
}

// Thay bằng logic lấy giá SJC thực tế của bạn
async function getSJCPrice() {
  return 90000000; 
}

/* ===== SAVE LOGIC ===== */
async function saveHistory(entry) {
  try {
    const last = await History.findOne().sort({ createdAt: -1 });
    // Chỉ lưu nếu giá SJC thay đổi
    if (!last || last.sjc !== entry.sjc) {
      await History.create(entry);
      console.log("💾 Đã lưu bản ghi mới vào MongoDB");
      
      const count = await History.countDocuments();
      if (count > 200) {
        const oldest = await History.findOne().sort({ createdAt: 1 });
        if (oldest) await History.deleteOne({ _id: oldest._id });
      }
    }
  } catch (e) { console.log("❌ Save error:", e); }
}

/* ===== UPDATE MAIN ===== */
async function updateData() {
  try {
    const usd = await getUSDRate();
    const xau = await getWorldGoldPrice();
    const sjc = await getSJCPrice();

    const worldVND = xau * usd * (37.5 / 31.1035);
    const diff = sjc - worldVND;
    const percent = ((diff / worldVND) * 100).toFixed(2) + "%";

    latestData = {
      time: new Date().toISOString(), // LUÔN LƯU DẠNG CHUẨN ISO
      date: getTodayVN(),
      usd, xau, sjc,
      worldVND: Math.round(worldVND),
      diff: Math.round(diff),
      percent
    };

    await saveHistory(latestData);
  } catch (e) { console.log("❌ Update error:", e.message); }
}

cron.schedule("*/2 * * * *", updateData);

app.get("/api/gold", (req, res) => res.json(latestData || {}));
app.get("/api/history", async (req, res) => {
  const data = await History.find().sort({ createdAt: -1 });
  res.json(data);
});
app.delete("/api/history", async (req, res) => {
  await History.deleteMany({});
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
  updateData();
});