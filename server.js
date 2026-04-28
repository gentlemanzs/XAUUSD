const express = require("express");
const axios = require("axios");
const cron = require("node-cron");
const cors = require("cors");
const mongoose = require("mongoose");
const cheerio = require("cheerio");
const compression = require("compression"); // Thư viện nén GZIP
const https = require("https"); // Thư viện cấu hình Keep-Alive

const app = express();
app.use(compression()); // Bật nén GZIP để giảm 70% dung lượng băng thông
app.use(cors());
app.use(express.json()); // Cho phép server đọc body JSON để xóa nhiều log

// Thêm maxAge để tận dụng Browser Cache cho file tĩnh (HTML, CSS, JS, Ảnh)
app.use(express.static("public", { maxAge: "1d" })); 

const PORT = process.env.PORT || 3000;

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

// Đánh Index cho createdAt giúp Database sort nhanh như chớp và không bị nghẽn RAM
HistorySchema.index({ createdAt: -1 });

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
// Tạo Agent giữ kết nối mở sẵn (Keep-Alive) giúp tăng tốc độ cào dữ liệu
const httpsAgent = new https.Agent({ keepAlive: true });

async function fetchWithRetry(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await axios.get(url, { 
        timeout: 10000,
        httpsAgent, // Áp dụng Keep-Alive
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

/* ===== LOGIC KHUNG GIỜ GIAO DỊCH (ĐÃ CÓ BIẾN TZ TRÊN RAILWAY) ===== */
function isWithinTradingHours() {
  const now = new Date(); 
  
  const day = now.getDay(); 
  const hour = now.getHours();
  const minute = now.getMinutes();
  
  const timeVal = hour + minute / 60;

  if (day === 0) return false;
  if (day === 1 && timeVal < 8.5) return false;
  if (day === 6 && timeVal > 10.5) return false;
  
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
  // Thêm .lean() trả về JSON thuần giúp API nhanh gấp 2-3 lần
  const data = await History.find().sort({ createdAt: -1 }).lean();
  res.json(data);
});

// Xóa 1 hoặc nhiều bản ghi cùng lúc theo danh sách ID
app.post("/api/history/bulk-delete", async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids)) {
      return res.status(400).json({ error: "Invalid data" });
    }
    await History.deleteMany({ _id: { $in: ids } });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: "Không thể xóa bản ghi" });
  }
});

/* ===== START ===== */
app.listen(PORT, () => {
  console.log("🚀 Server đang chạy trên port", PORT);
  updateData();
});