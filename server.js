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

/* --- KẾT NỐI DATABASE --- */
mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ [Database] Đã thông suốt!"))
  .catch(err => console.error("❌ [Database] Lỗi kết nối:", err.message));

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
    const res = await axios.get(url, { 
      timeout: 10000, 
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" } 
    });
    return res.data;
  } catch (e) { return null; }
}

/* --- 1. LẤY TỶ GIÁ USD (BÁN RA CHUẨN) --- */
async function getUSDRate() {
  try {
    const html = await fetchWithRetry("https://webgia.com/ty-gia/vietcombank/");
    if (!html) throw "Fail HTML";
    const clean = html.replace(/\s+/g, " ");
    // Tìm cụm "USD", sau đó bỏ qua cột "Mua", lấy cột "Bán" (con số thứ 3)
    const match = clean.match(/USD.*?([0-9]{2}\.[0-9]{3}).*?([0-9]{2}\.[0-9]{3}).*?([0-9]{2}\.[0-9]{3})/);
    const rate = match ? parseFloat(match[3].replace(".", "")) : 26368;
    console.log(`💵 Tỷ giá USD: ${rate}`);
    return rate;
  } catch (e) { return 26368; }
}

/* --- 2. LẤY GIÁ VÀNG THẾ GIỚI --- */
async function getWorldGoldPrice() {
  try {
    const data = await fetchWithRetry("https://api.gold-api.com/price/XAU");
    return data?.price ? parseFloat(data.price) : 2350;
  } catch { return 2350; }
}

/* --- 3. LẤY GIÁ VÀNG SJC (CHÍNH XÁC DÒNG SJC TP.HCM) --- */
async function getSJCPrice() {
  try {
    const html = await fetchWithRetry("https://webgia.com/gia-vang/sjc/");
    if (!html) throw "Fail HTML";
    
    // Bước quan trọng: Loại bỏ tất cả tag HTML để lấy text thuần
    const text = html.replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ');
    
    // Tìm đoạn chứa "SJC TP.HCM", sau đó lấy 2 con số có dạng 8x.xxx.xxx đứng gần nhất
    const match = text.match(/SJC TP\.HCM.*?([0-9]{2}\.[0-9]{3}\.[0-9]{3}).*?([0-9]{2}\.[0-9]{3}\.[0-9]{3})/);
    
    if (match && match[2]) {
      const sellPrice = parseInt(match[2].replace(/\./g, ""));
      console.log(`🧈 Giá SJC (Bán): ${sellPrice}`);
      return sellPrice;
    }
    throw "Không tìm thấy giá SJC";
  } catch (e) {
    console.log("❌ Lỗi cào SJC:", e);
    return 84000000; // Giá fallback gần đúng nhất hiện tại
  }
}

/* --- LOGIC CẬP NHẬT & TÍNH TOÁN MARKET GAP --- */
async function updateData() {
  try {
    const [usd, xau, sjc] = await Promise.all([getUSDRate(), getWorldGoldPrice(), getSJCPrice()]);
    
    // 1 lượng = 1.20565 ounce
    const worldVND = xau * 1.20565 * usd;
    
    // Market Gap = SJC - Thế giới quy đổi
    const diff = sjc - worldVND;
    const percent = (diff / worldVND) * 100;

    latestData = {
      time: new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }),
      usd, xau, sjc,
      worldVND: Math.round(worldVND),
      diff: Math.round(diff), // Đây là con số quan trọng ở mục Market Gap
      percent: percent.toFixed(2) + "%"
    };

    console.log(`📊 Kết quả: SJC(${sjc}) - TG(${Math.round(worldVND)}) = Gap(${Math.round(diff)})`);

    if (mongoose.connection.readyState === 1) {
      await History.create(latestData);
      const count = await History.countDocuments();
      if (count > 150) await History.findOneAndDelete({}, { sort: { createdAt: 1 } });
    }
  } catch (e) { console.error("❌ Lỗi Update:", e); }
}

cron.schedule("*/2 * * * *", updateData);

app.get("/api/gold", (req, res) => res.json(latestData || { message: "Khởi tạo..." }));
app.get("/api/history", async (req, res) => {
  const data = await History.find().sort({ createdAt: -1 }).limit(100);
  res.json(data.reverse());
});
app.delete("/api/history", async (req, res) => {
  await History.deleteMany({});
  res.json({ message: "Đã xóa lịch sử" });
});
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public/index.html")));

app.listen(PORT, () => {
  console.log(`🚀 Server on port ${PORT}`);
  updateData();
});