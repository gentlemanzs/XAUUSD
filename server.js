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
.then(() => console.log("✅ MongoDB connected (Railway)"))
.catch(err => console.error("❌ MongoDB error:", err));

/* ===== SCHEMA ===== */
const HistorySchema = new mongoose.Schema({
  time: String, // Lưu ISO String
  date: String, // yyyy-mm-dd (Giờ VN)
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

async function fetchHTML(url) {
  try {
    const res = await axios.get(url, { 
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    return res.data;
  } catch (e) { return null; }
}

/* ===== CÀO GIÁ SJC (Dòng 1, Cột 3) ===== */
async function getSJCPrice() {
  try {
    const html = await fetchHTML("https://sjc.com.vn/gia-vang-online");
    if (!html) return null;

    // Tìm tất cả các số có định dạng giá tiền (ví dụ: 89.000 hoặc 89,000) trong bảng
    const priceMatches = html.match(/[0-9]{2}[\.,][0-9]{3}/g);
    
    if (priceMatches && priceMatches.length >= 2) {
      // Dòng 1 thường có: Cột 2 (Mua vào), Cột 3 (Bán ra)
      // Cột 3 của dòng 1 sẽ là phần tử index 1 trong mảng kết quả match
      const rawPrice = priceMatches[1].replace(/[\.,]/g, "");
      return parseInt(rawPrice) * 1000; // Nhân 1000 vì SJC niêm yết đơn vị nghìn đồng
    }
    return null;
  } catch (e) {
    console.log("❌ Lỗi cào SJC:", e.message);
    return null;
  }
}

/* ===== TỶ GIÁ USD ===== */
async function getUSDRate() {
  const html = await fetchHTML("https://webgia.com/ty-gia/vietcombank/");
  if (!html) return 25450;
  const nums = html.replace(/\s+/g, "").match(/[0-9]{2}\.[0-9]{3},[0-9]{2}/g);
  if (!nums) return 25450;
  const values = nums.map(n => parseFloat(n.replace(/\./g, "").replace(",", ".")));
  return Math.max(...values.filter(v => v > 24000 && v < 26000));
}

/* ===== GIÁ VÀNG THẾ GIỚI ===== */
async function getWorldGold() {
  try {
    const res = await axios.get("https://api.gold-api.com/price/XAU");
    return res.data.price || 2350;
  } catch { return 2350; }
}

/* ===== UPDATE & SAVE ===== */
async function updateData() {
  try {
    const [usd, xau, sjcReal] = await Promise.all([
      getUSDRate(),
      getWorldGold(),
      getSJCPrice()
    ]);

    if (!sjcReal) {
        console.log("⚠️ Không lấy được giá SJC, bỏ qua lượt cập nhật này.");
        return;
    }

    const worldVND = Math.round(xau * usd * (37.5 / 31.1035));
    const diff = sjcReal - worldVND;
    const percent = ((diff / worldVND) * 100).toFixed(2) + "%";

    latestData = {
      time: new Date().toISOString(), // Lưu ISO chuẩn
      date: getTodayVN(),
      usd, xau, sjc: sjcReal, worldVND, diff, percent
    };

    // Lưu history nếu giá SJC thay đổi
    const last = await History.findOne().sort({ createdAt: -1 });
    if (!last || last.sjc !== sjcReal) {
      await History.create(latestData);
      console.log(`💾 Đã lưu SJC mới: ${sjcReal.toLocaleString()} VND`);
    }

  } catch (e) { console.log("❌ Lỗi Update:", e.message); }
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