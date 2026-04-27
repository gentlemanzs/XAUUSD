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

/* --- CẤU HÌNH --- */
const PORT = process.env.PORT || 8080;
const MONGO_URI = process.env.MONGO_URI;

/* --- KẾT NỐI MONGODB (Sửa lỗi Buffer Timeout) --- */
mongoose.connect(MONGO_URI, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 10000,
})
.then(() => console.log("✅ [Database] Đã kết nối MongoDB Atlas!"))
.catch(err => console.error("❌ [Database] Lỗi kết nối:", err.message));

/* --- SCHEMA --- */
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

/* --- CHỨC NĂNG CÀO DỮ LIỆU CHÍNH XÁC --- */
async function fetchWithRetry(url) {
  try {
    const res = await axios.get(url, {
      timeout: 10000,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
    });
    return res.data;
  } catch (e) { return null; }
}

/* --- 1. LẤY TỶ GIÁ USD (Sửa lỗi lấy sai con số 26.368) --- */
async function getUSDRate() {
  try {
    const html = await fetchWithRetry("https://webgia.com/ty-gia/vietcombank/");
    if (!html) throw "Không tải được HTML";

    const clean = html.replace(/\s+/g, " ");
    // Tìm dòng chứa "USD" và lấy các con số ngay sau đó
    const match = clean.match(/USD.*?([0-9]{2}\.[0-9]{3}).*?([0-9]{2}\.[0-9]{3}).*?([0-9]{2}\.[0-9]{3})/);
    
    if (match && match[3]) {
      // match[1]: Mua tiền mặt, match[2]: Mua CK, match[3]: GIÁ BÁN
      const usdRate = parseFloat(match[3].replace(".", ""));
      console.log(`💵 USD (Bán ra): ${usdRate}`);
      return usdRate;
    }
    throw "Không tìm thấy đúng cột tỷ giá";
  } catch (e) {
    console.log("⚠️ Lỗi USD, dùng giá dự phòng (26.300)");
    return 26300; 
  }
}

/* --- 2. LẤY GIÁ VÀNG THẾ GIỚI --- */
async function getWorldGoldPrice() {
  try {
    const data = await fetchWithRetry("https://api.gold-api.com/price/XAU");
    return data?.price || 2350;
  } catch { return 2350; }
}

/* --- 3. LẤY GIÁ VÀNG SJC (Lấy giá Bán) --- */
async function getSJCPrice() {
  try {
    const html = await fetchWithRetry("https://webgia.com/gia-vang/sjc/");
    if (!html) throw "Fail";
    const clean = html.replace(/\s+/g, " ");
    const nums = clean.match(/[0-9]{2}\.[0-9]{3}\.[0-9]{3}/g);
    // nums[1] thường là giá bán ra trên webgia
    const sjcPrice = parseInt(nums[1].replace(/\./g, ""));
    console.log(`🧈 SJC (Bán ra): ${sjcPrice}`);
    return sjcPrice;
  } catch (e) { return 83000000; }
}

/* --- LƯU LỊCH SỬ (Sửa lỗi không ghi được) --- */
async function saveHistory(entry) {
  try {
    if (mongoose.connection.readyState !== 1) return;

    // Ép ghi dữ liệu để kiểm tra (Xóa bớt điều kiện so sánh để test)
    await History.create(entry);
    console.log("💾 [MongoDB] Đã lưu 1 bản ghi mới.");

    // Tự động dọn dẹp: Chỉ giữ lại 100 bản ghi mới nhất
    const count = await History.countDocuments();
    if (count > 100) {
      await History.findOneAndDelete({}, { sort: { createdAt: 1 } });
    }
  } catch (e) {
    console.error("❌ [MongoDB] Lỗi lưu:", e.message);
  }
}

async function updateData() {
  console.log(`\n--- Cập nhật: ${new Date().toLocaleTimeString()} ---`);
  try {
    const [usd, xau, sjc] = await Promise.all([getUSDRate(), getWorldGoldPrice(), getSJCPrice()]);
    const worldVND = xau * usd * (37.5 / 31.1035);
    const diff = sjc - worldVND;
    const percent = (diff / worldVND) * 100;

    latestData = {
      time: new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }),
      usd, xau, sjc,
      worldVND: Math.round(worldVND),
      diff: Math.round(diff),
      percent: percent.toFixed(2) + "%"
    };

    await saveHistory(latestData);
  } catch (e) { console.log("❌ Lỗi Update:", e); }
}

/* --- ROUTES --- */
cron.schedule("*/2 * * * *", updateData);

app.get("/api/gold", (req, res) => res.json(latestData || { message: "Đang khởi tạo..." }));

app.get("/api/history", async (req, res) => {
  try {
    const data = await History.find().sort({ createdAt: -1 }).limit(100);
    res.json(data.reverse());
  } catch (e) { res.status(500).send("Lỗi DB"); }
});

app.delete("/api/history", async (req, res) => {
  try {
    await History.deleteMany({});
    res.json({ message: "Đã xóa DB" });
  } catch (e) { res.status(500).send("Lỗi"); }
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public/index.html")));

app.listen(PORT, () => {
  console.log(`🚀 Server chạy tại port ${PORT}`);
  updateData();
});