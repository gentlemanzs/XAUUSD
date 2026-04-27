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

/* --- CẤU HÌNH HỆ THỐNG --- */
const PORT = process.env.PORT || 8080;
const MONGO_URI = process.env.MONGO_URI;

/* --- KẾT NỐI MONGODB --- */
mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected!"))
  .catch(err => console.error("❌ Lỗi kết nối MongoDB:", err));

/* --- SCHEMA DỮ LIỆU --- */
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

/* --- HELPER FETCH --- */
async function fetchWithRetry(url) {
  try {
    const res = await axios.get(url, {
      timeout: 10000,
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    return res.data;
  } catch (e) {
    console.error(`⚠️ Lỗi tải URL: ${url}`);
    return null;
  }
}

/* --- 1. CÀO TỶ GIÁ USD (VIETCOMBANK) --- */
async function getUSDRate() {
  try {
    const html = await fetchWithRetry("https://webgia.com/ty-gia/vietcombank/");
    if (!html) throw "Fail HTML";
    const clean = html.replace(/\s+/g, " ");
    const nums = clean.match(/[0-9]{2}\.[0-9]{3}/g); // Tìm dạng 25.xxx
    if (!nums) throw "Không thấy USD";
    
    // Lấy giá trị bán ra (thường là con số cao nhất trong nhóm 25.xxx)
    const values = nums.map(n => parseFloat(n.replace(".", "")));
    const usdRate = Math.max(...values);
    console.log(`💵 USD: ${usdRate}`);
    return usdRate;
  } catch (e) {
    return 25450;
  }
}

/* --- 2. CÀO GIÁ VÀNG THẾ GIỚI (XAU) --- */
async function getWorldGoldPrice() {
  try {
    const data = await fetchWithRetry("https://api.gold-api.com/price/XAU");
    return data?.price || 2350;
  } catch {
    return 2350;
  }
}

/* --- 3. CÀO GIÁ VÀNG SJC --- */
async function getSJCPrice() {
  try {
    const html = await fetchWithRetry("https://webgia.com/gia-vang/sjc/");
    if (!html) throw "Fail HTML";
    const clean = html.replace(/\s+/g, " ");
    // Tìm số dạng 8x.xxx.xxx
    const nums = clean.match(/[0-9]{2}\.[0-9]{3}\.[0-9]{3}/g);
    if (!nums) throw "Không thấy SJC";
    
    const values = nums.map(n => parseInt(n.replace(/\./g, "")));
    // Lấy giá Bán ra (thường là giá trị lớn thứ 2 hoặc thứ 4 trong danh sách cào được)
    const sjcPrice = values[1] || values[0]; 
    console.log(`🧈 SJC: ${sjcPrice}`);
    return sjcPrice;
  } catch (e) {
    return 89000000;
  }
}

/* --- LƯU LỊCH SỬ --- */
async function saveHistory(entry) {
  try {
    const lastEntry = await History.findOne().sort({ createdAt: -1 });
    // Chỉ lưu nếu giá SJC hoặc XAU thay đổi để tránh trùng lặp
    if (!lastEntry || lastEntry.sjc !== entry.sjc || lastEntry.xau !== entry.xau) {
      await History.create(entry);
      console.log("💾 Đã ghi nhận lịch sử mới.");
    }
  } catch (e) {
    console.error("❌ Lỗi MongoDB:", e.message);
  }
}

/* --- CẬP NHẬT TỔNG THỂ --- */
async function updateData() {
  console.log(`\n[${new Date().toLocaleTimeString()}] Đang cập nhật...`);
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
      time: new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }),
      usd,
      xau,
      sjc,
      worldVND: Math.round(worldVND),
      diff: Math.round(diff),
      percent: percent.toFixed(2) + "%"
    };

    await saveHistory(latestData);
  } catch (e) {
    console.log("❌ Lỗi Update:", e);
  }
}

/* --- CHU KỲ & ROUTING --- */
cron.schedule("*/2 * * * *", updateData);

app.get("/api/gold", (req, res) => {
  res.json(latestData || { message: "Vui lòng đợi khởi tạo..." });
});

app.get("/api/history", async (req, res) => {
  try {
    const data = await History.find().sort({ createdAt: -1 }).limit(100);
    res.json(data.reverse());
  } catch (e) {
    res.status(500).send("Lỗi server");
  }
});

app.delete("/api/history", async (req, res) => {
  try {
    await History.deleteMany({});
    res.json({ message: "Đã xóa lịch sử thành công." });
  } catch (e) {
    res.status(500).send("Lỗi xóa");
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  updateData();
});