const express = require("express");
const axios = require("axios");
const cron = require("node-cron");
const cors = require("cors");
const path = require("path");
const mongoose = require("mongoose"); // Thêm mongoose
require("dotenv").config(); // Hỗ trợ đọc file .env nếu chạy local

const app = express();
app.use(cors());
app.use(express.json());

/* 🔥 PORT & MONGODB CONFIG */
const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI; 

/* 🔥 CONNECT MONGODB */
mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected!"))
  .catch(err => console.error("❌ MongoDB Connection Error:", err));

/* 🔥 DEFINE SCHEMA (Cấu trúc dữ liệu) */
const historySchema = new mongoose.Schema({
  time: String,
  usd: Number,
  xau: Number,
  sjc: Number,
  worldVND: Number,
  diff: Number,
  percent: String,
  createdAt: { type: Date, default: Date.now } // Dùng để sắp xếp chính xác
});

const History = mongoose.model("History", historySchema);

/* 🔥 SERVE FRONTEND */
app.use(express.static("public"));

let latestData = null;

/* ===== CONFIG ===== */
const CONFIG = {
  TIMEOUT: 8000,
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

/* ===== USD RATE ===== */
async function getUSDRate() {
  try {
    const html = await fetchWithRetry("https://webgia.com/ty-gia/vietcombank/");
    if (!html) throw "Fetch fail";
    const clean = html.replace(/\s+/g, " ");
    const nums = clean.match(/[0-9]{2,3}\.[0-9]{3},[0-9]{2}/g);
    if (!nums) throw "Không tìm thấy số";
    const values = nums.map(n => parseFloat(n.replace(/\./g, "").replace(",", ".")));
    const usdValues = values.filter(v => v > 20000 && v < 30000);
    return Math.max(...usdValues);
  } catch (e) {
    return 25450; // Giá dự phòng
  }
}

/* ===== WORLD GOLD (XAU) ===== */
async function getWorldGoldPrice() {
  try {
    const data = await fetchWithRetry("https://api.gold-api.com/price/XAU");
    return data?.price || 2350;
  } catch {
    return 2350;
  }
}

/* ===== SJC PRICE (Cần cập nhật logic cào thật ở đây) ===== */
async function getSJCPrice() {
  // Tạm thời để giá cứng hoặc bạn có thể cào từ web giá tương tự USD
  return 89000000; 
}

/* ===== SAVE TO MONGODB ===== */
async function saveHistory(entry) {
  try {
    // Lấy bản ghi cuối cùng trong DB để so sánh
    const lastEntry = await History.findOne().sort({ createdAt: -1 });

    // Chỉ lưu nếu giá SJC hoặc giá Thế giới thay đổi
    if (!lastEntry || lastEntry.sjc !== entry.sjc || lastEntry.xau !== entry.xau) {
      await History.create(entry);
      console.log("💾 Đã lưu lịch sử vào MongoDB Atlas");
    }
  } catch (e) {
    console.error("❌ Lỗi lưu MongoDB:", e);
  }
}

/* ===== UPDATE MAIN LOGIC ===== */
async function updateData() {
  console.log("\n⏳ Updating Data...");
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
    console.log("✅ Update hoàn tất");
  } catch (e) {
    console.log("❌ UPDATE ERROR:", e);
  }
}

/* ===== CRON (2 phút/lần) ===== */
cron.schedule("*/2 * * * *", updateData);

/* ===== API ENDPOINTS ===== */

// 1. Lấy giá hiện tại
app.get("/api/gold", (req, res) => {
  res.json(latestData || { message: "Đang khởi tạo dữ liệu..." });
});

// 2. Lấy lịch sử từ MongoDB (Giới hạn 100 bản ghi mới nhất)
app.get("/api/history", async (req, res) => {
  try {
    const data = await History.find()
      .sort({ createdAt: -1 })
      .limit(100);
    res.json(data.reverse()); // Đảo ngược lại để vẽ biểu đồ từ cũ đến mới
  } catch (e) {
    res.status(500).json({ error: "Lỗi lấy dữ liệu" });
  }
});

// 3. Xóa lịch sử (Dùng cho nút Clear trên giao diện)
app.delete("/api/history", async (req, res) => {
  try {
    await History.deleteMany({});
    res.json({ message: "Đã xóa sạch lịch sử" });
  } catch (e) {
    res.status(500).json({ error: "Lỗi khi xóa" });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

/* ===== START SERVER ===== */
app.listen(PORT, () => {
  console.log(`🚀 Server đang chạy tại Port: ${PORT}`);
  updateData(); // Chạy ngay lập tức khi khởi động
});