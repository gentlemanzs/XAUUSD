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
mongoose.connect(process.env.MONGO_URI, {
  serverSelectionTimeoutMS: 5000
})
.then(() => console.log("✅ MongoDB connected"))
.catch(err => {
  console.error("❌ MongoDB error:", err);
  process.exit(1);
});

/* ===== SCHEMA ===== */
const HistorySchema = new mongoose.Schema({
  time: String, // Lưu dạng ISO để dễ xử lý ở frontend
  date: String, // yyyy-mm-dd (giờ VN)
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
  return new Date(new Date().getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/* ===== FETCH HELPER ===== */
async function fetchWithRetry(url) {
  try {
    const res = await axios.get(url, { 
      timeout: 8000,
      headers: { 'User-Agent': 'Mozilla/5.0' } 
    });
    return res.data;
  } catch { return null; }
}

/* ===== USD RATE (Target "Bán" Column) ===== */
async function getUSDRate() {
  try {
    const html = await fetchWithRetry("https://webgia.com/ty-gia/vietcombank/");
    if (!html) return 25450;
    const clean = html.replace(/\s+/g, " ");
    const nums = clean.match(/[0-9]{2,3}\.[0-9]{3},[0-9]{2}/g);
    const values = nums.map(n => parseFloat(n.replace(/\./g, "").replace(",", ".")));
    // Lấy giá trị lớn nhất thường là giá "Bán"
    return Math.max(...values.filter(v => v > 24000 && v < 26000));
  } catch { return 25450; }
}

/* ===== WORLD GOLD (XAU) ===== */
async function getWorldGoldPrice() {
  const data = await fetchWithRetry("https://api.gold-api.com/price/XAU");
  return data?.price || 2350;
}

/* ===== SJC PRICE (Cập nhật lấy giá thật từ Webgia) ===== */
async function getSJCPrice() {
  try {
    const html = await fetchWithRetry("https://webgia.com/gia-vang/sjc/");
    if (!html) return 85000000;
    const clean = html.replace(/\s+/g, " ");
    // Regex tìm số có dạng 8x.xxx.000 hoặc 9x.xxx.000
    const nums = clean.match(/[0-9]{2}\.[0-9]{3}\.[0-9]{3}/g);
    if (nums) {
      const values = nums.map(n => parseInt(n.replace(/\./g, "")));
      // Lấy giá trị cao nhất (thường là giá bán ra của SJC)
      return Math.max(...values.filter(v => v > 50000000));
    }
    return 85000000;
  } catch { return 85000000; }
}

/* ===== SAVE LOGIC ===== */
async function saveHistory(entry) {
  try {
    const today = getTodayVN();
    const firstToday = await History.findOne({ date: today }).sort({ createdAt: 1 });
    const last = await History.findOne().sort({ createdAt: -1 });

    // Lưu nếu: Bản ghi đầu tiên trong ngày HOẶC giá SJC thay đổi so với lần gần nhất
    if (!firstToday || !last || last.sjc !== entry.sjc) {
      await History.create(entry);
      console.log(`💾 Saved SJC: ${entry.sjc} at ${new Date().toISOString()}`);

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
    const [usd, xau, sjc] = await Promise.all([
      getUSDRate(),
      getWorldGoldPrice(),
      getSJCPrice()
    ]);

    const worldVND = xau * usd * (37.5 / 31.1035);
    const diff = sjc - worldVND;
    const percent = (diff / worldVND) * 100;

    latestData = {
      time: new Date().toISOString(), // Lưu dạng ISO chuẩn
      date: getTodayVN(),
      usd,
      xau,
      sjc,
      worldVND: Math.round(worldVND),
      diff: Math.round(diff),
      percent: percent.toFixed(2) + "%"
    };

    await saveHistory(latestData);
  } catch (e) { console.log("❌ UPDATE ERROR:", e); }
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
  console.log("🚀 Server running on", PORT);
  updateData();
});