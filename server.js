const express = require("express");
const axios = require("axios");
const cron = require("node-cron");
const cors = require("cors");
const mongoose = require("mongoose");
const cheerio = require("cheerio");

const app = express();
app.use(cors());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "123456";

/* ===== CONNECT MONGO ===== */
mongoose.connect(process.env.MONGO_URI, {
  serverSelectionTimeoutMS: 5000
})
.then(() => console.log("✅ MongoDB connected"))
.catch(err => {
  console.error("❌ MongoDB error:", err);
  process.exit(1);
});

/* ===== SCHEMA TỐI ƯU ===== */
const HistorySchema = new mongoose.Schema({
  usd: Number,
  xau: Number,
  sjc: Number,
  worldVND: Number,
  diff: Number,
  percent: String,
  status: String
}, { timestamps: true });

const History = mongoose.model("History", HistorySchema);

let latestData = null;

/* ===== HELPER: USER AGENTS ===== */
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
];

function getRandomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/* ===== FETCH ===== */
async function fetchWithRetry(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await axios.get(url, { 
        timeout: 10000,
        headers: { "User-Agent": getRandomUA(), "Accept-Language": "vi-VN,vi;q=0.9" }
      });
      return res.data;
    } catch (e) {
      console.log(`⚠️ Thử lại lần ${i + 1} cho ${url}...`);
      if (i === retries - 1) return null;
    }
  }
}

async function getUSDRate() {
  try {
    const html = await fetchWithRetry("https://webgia.com/ty-gia/vietcombank/");
    if (!html) return 1000;
    const $ = cheerio.load(html);
    const sellPriceText = $('td:contains("USD")').parent().find('td').last().text().trim(); 
    const rate = parseFloat(sellPriceText.replace(/\./g, "").replace(",", "."));
    return isNaN(rate) ? 1000 : rate;
  } catch {
    return 1000;
  }
}

async function getWorldGoldPrice() {
  try {
    const data = await fetchWithRetry("https://api.gold-api.com/price/XAU");
    return data?.price || 2350;
  } catch {
    return 2350;
  }
}

async function getSJCPrice() {
  try {
    const html = await fetchWithRetry("https://webgia.com/gia-vang/sjc/");
    if (!html) return 0;
    const $ = cheerio.load(html);
    const nameCell = $('td:contains("Vàng SJC 1L")').first();
    const sellPriceText = nameCell.next().next().text().trim();
    if (sellPriceText) {
      const pricePerChi = parseInt(sellPriceText.replace(/\./g, ""), 10);
      if (!isNaN(pricePerChi)) return pricePerChi * 10;
    }
    return 0;
  } catch (error) {
    return 0;
  }
}

/* ===== SAVE LOGIC (CHỈ LƯU KHI SJC THAY ĐỔI) ===== */
async function saveHistory(entry) {
  try {
    const last = await History.findOne().sort({ createdAt: -1 });
    
    // Điều kiện: Chưa có data HOẶC giá SJC mới khác giá SJC cũ
    if (!last || last.sjc !== entry.sjc) {
      await History.create(entry);
      console.log(`💾 Lịch sử: Đã lưu SJC mới là ${entry.sjc} (Cũ: ${last ? last.sjc : 'N/A'})`);

      // Tự động dọn dẹp nếu quá 200 bản ghi
      const count = await History.countDocuments();
      if (count > 200) {
        await History.findOneAndDelete({}, { sort: { createdAt: 1 } });
      }
    } else {
      console.log("⏭ SJC không đổi, bỏ qua ghi log vào Query History.");
    }
  } catch (e) {
    console.log("❌ Lỗi lưu DB:", e);
  }
}

/* ===== UPDATE ===== */
async function updateData() {
  try {
    let [usd, xau, sjc] = await Promise.all([ getUSDRate(), getWorldGoldPrice(), getSJCPrice() ]);
    const lastRecord = await History.findOne().sort({ createdAt: -1 });
    let isFallback = false;

    if (sjc <= 0 && lastRecord) { sjc = lastRecord.sjc; isFallback = true; }
    if (xau <= 0 && lastRecord) { xau = lastRecord.xau; isFallback = true; }
    if (usd === 1000 && lastRecord) { usd = lastRecord.usd; }

    if (sjc <= 0 || xau <= 0) {
      console.log("⚠️ Không có dữ liệu hợp lệ để cập nhật.");
      return;
    }

    const worldVND = xau * usd * (37.5 / 31.1035);
    const diff = sjc - worldVND;
    const percent = (diff / worldVND) * 100;

    latestData = {
      updatedAt: new Date(),
      usd: usd,
      xau: xau,
      sjc: sjc,
      worldVND: Math.round(worldVND),
      diff: Math.round(diff),
      percent: percent.toFixed(2) + "%",
      status: isFallback ? "Delayed" : "Live"
    };

    if (!isFallback) {
      await saveHistory(latestData);
    } else {
      console.log("🟡 Giá cào được bị lỗi, đang dùng giá dự phòng (Fallback). Không lưu log.");
    }
  } catch (e) {
    console.log("❌ Lỗi cập nhật:", e);
  }
}

/* ===== LOGIC KHUNG GIỜ GIAO DỊCH GMT+7 ===== */
function isWithinTradingHours() {
  // Lấy thời gian hiện tại chuẩn GMT+7
  const nowStr = new Date().toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" });
  const nowVN = new Date(nowStr);
  
  const day = nowVN.getDay(); // 0: CN, 1: T2, ..., 6: T7
  const hour = nowVN.getHours();
  const minute = nowVN.getMinutes();
  
  // Chuyển đổi ra số thập phân (VD: 8h30 = 8.5)
  const timeVal = hour + minute / 60;

  // Chủ Nhật (0) -> Nghỉ
  if (day === 0) return false;
  // Thứ 2 (1) trước 8h30 -> Nghỉ
  if (day === 1 && timeVal < 8.5) return false;
  // Thứ 7 (6) sau 10h30 -> Nghỉ
  if (day === 6 && timeVal > 10.5) return false;
  
  // Tất cả thời gian còn lại (Từ 8h30 T2 đến 10h30 T7) -> Chạy
  return true;
}

/* ===== CRON JOB KHUNG GIỜ ===== */
cron.schedule("*/15 * * * *", () => {
  if (isWithinTradingHours()) {
    console.log("🔄 Bắt đầu cronjob cập nhật dữ liệu...");
    updateData();
  } else {
    console.log("⏸ Đang ngoài giờ giao dịch (Chỉ chạy 8h30 T2 - 10h30 T7 GMT+7). Bỏ qua tự cập nhật.");
  }
});

/* ===== API ===== */
app.get("/api/gold", (req, res) => {
  res.json(latestData || {});
});

app.get("/api/history", async (req, res) => {
  const data = await History.find().sort({ createdAt: -1 });
  res.json(data);
});

// Xóa toàn bộ lịch sử
app.delete("/api/history", async (req, res) => {
  const userKey = req.headers['x-admin-key'];
  if (userKey !== ADMIN_KEY) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  await History.deleteMany({});
  res.json({ ok: true });
});

// Xóa 1 bản ghi cụ thể theo ID
app.delete("/api/history/:id", async (req, res) => {
  const userKey = req.headers['x-admin-key'];
  if (userKey !== ADMIN_KEY) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  try {
    await History.findByIdAndDelete(req.params.id);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: "Không thể xóa bản ghi này" });
  }
});

/* ===== START ===== */
app.listen(PORT, () => {
  console.log("🚀 Server đang chạy trên port", PORT);
  // Khởi chạy 1 lần khi bật server để luôn có data initial (không phụ thuộc giờ giấc)
  updateData();
});