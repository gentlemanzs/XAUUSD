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

/* --- KẾT NỐI DATABASE (THÊM TIMEOUT ĐỂ TRÁNH TREO) --- */
mongoose.connect(MONGO_URI, { 
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000 
})
.then(() => console.log("✅ [DB] Connected!"))
.catch(err => console.error("❌ [DB] Connection Error: Kiểm tra lại MONGO_URI trên Railway!"));

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

/* --- HELPER CÀO DỮ LIỆU --- */
async function fetchSource(url) {
  try {
    const res = await axios.get(url, {
      timeout: 15000,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
    });
    return res.data.replace(/\s+/g, " "); // Làm sạch khoảng trắng rác
  } catch (e) { return null; }
}

/* --- 1. CÀO USD (CHÍNH XÁC CỘT BÁN) --- */
async function getUSDRate() {
  const html = await fetchSource("https://webgia.com/ty-gia/vietcombank/");
  if (!html) return 26368;
  // Tìm khối USD và bốc 3 số XX.XXX đầu tiên sau nó (Mua/CK/Bán)
  const match = html.match(/USD.*?([0-9]{2}\.[0-9]{3}).*?([0-9]{2}\.[0-9]{3}).*?([0-9]{2}\.[0-9]{3})/);
  if (match && match[3]) {
    const rate = parseFloat(match[3].replace(".", ""));
    console.log(`💵 USD (Bán): ${rate}`);
    return rate;
  }
  return 26368;
}

/* --- 2. GIÁ VÀNG THẾ GIỚI --- */
async function getWorldGoldPrice() {
  try {
    const res = await axios.get("https://api.gold-api.com/price/XAU");
    return parseFloat(res.data.price);
  } catch { return 2350; }
}

/* --- 3. CÀO SJC (CHÍNH XÁC SJC TP.HCM - CỘT BÁN) --- */
async function getSJCPrice() {
  const html = await fetchSource("https://webgia.com/gia-vang/sjc/");
  if (!html) return 84000000;
  // Bóc tách đúng dòng SJC TP.HCM
  const match = html.match(/SJC TP\.HCM.*?([0-9]{2}\.[0-9]{3}\.[0-9]{3}).*?([0-9]{2}\.[0-9]{3}\.[0-9]{3})/);
  if (match && match[2]) {
    const price = parseInt(match[2].replace(/\./g, ""));
    console.log(`🧈 SJC (Bán): ${price}`);
    return price;
  }
  return 84000000;
}

/* --- LOGIC CẬP NHẬT & TÍNH TOÁN MARKET GAP --- */
async function updateData() {
  console.log(`\n--- Update @ ${new Date().toLocaleTimeString()} ---`);
  try {
    const [usd, xau, sjc] = await Promise.all([getUSDRate(), getWorldGoldPrice(), getSJCPrice()]);

    // Công thức chuẩn: (Thế giới * 1.20565 * USD)
    const worldVND = xau * 1.20565 * usd;
    const diff = sjc - worldVND;
    const percent = (diff / worldVND) * 100;

    latestData = {
      time: new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }),
      usd, xau, sjc,
      worldVND: Math.round(worldVND),
      diff: Math.round(diff), // Đây là Market Gap
      percent: percent.toFixed(2) + "%"
    };

    console.log(`📊 GAP: ${latestData.diff.toLocaleString()} VND`);

    // Ghi vào MongoDB nếu kết nối OK
    if (mongoose.connection.readyState === 1) {
      await History.create(latestData);
      const count = await History.countDocuments();
      if (count > 200) await History.findOneAndDelete({}, { sort: { createdAt: 1 } });
    }
  } catch (e) { console.error("❌ Lỗi Update:", e.message); }
}

/* --- API ROUTES --- */
cron.schedule("*/2 * * * *", updateData);

app.get("/api/gold", (req, res) => res.json(latestData || { message: "Đang tải..." }));

app.get("/api/history", async (req, res) => {
  try {
    const data = await History.find().sort({ createdAt: -1 }).limit(100);
    res.json(data.reverse());
  } catch (e) { res.status(500).send("DB Error"); }
});

app.delete("/api/history", async (req, res) => {
  try {
    await History.deleteMany({});
    res.json({ message: "DB Cleared" });
  } catch (e) { res.status(500).send("Error"); }
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public/index.html")));

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  updateData();
});