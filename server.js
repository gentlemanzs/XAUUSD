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
const ADMIN_KEY = process.env.ADMIN_KEY || "123456"; // Đổi thành mật khẩu của bạn trên Railway Variables

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
// Sử dụng timestamps mặc định của MongoDB thay vì chuỗi string thủ công
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

/* ===== CÀO DỮ LIỆU ===== */
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

/* ===== SAVE LOGIC TỐI ƯU ===== */
async function saveHistory(entry) {
  try {
    const last = await History.findOne().sort({ createdAt: -1 });
    
    // Lưu khi giá SJC đổi HOẶC giá XAU đổi trên 5 USD
    const sjcChanged = !last || last.sjc !== entry.sjc;
    const xauChanged = !last || Math.abs(last.xau - entry.xau) >= 5;

    if (sjcChanged || xauChanged) {
      await History.create(entry);
      console.log("💾 Đã lưu biến động SJC/XAU mới vào database.");

      const count = await History.countDocuments();
      if (count > 200) {
        await History.findOneAndDelete({}, { sort: { createdAt: 1 } });
      }
    } else {
      console.log("⏭ Thị trường đi ngang, bỏ qua lưu lịch sử.");
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
      console.log("⚠️ Không có dữ liệu để cập nhật.");
      return;
    }

    const worldVND = xau * usd * (37.5 / 31.1035);
    const diff = sjc - worldVND;
    const percent = (diff / worldVND) * 100;

    latestData = {
      updatedAt: new Date(), // Truyền thời gian chuẩn ISO xuống Frontend
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
      console.log("🟡 Đang hiển thị dữ liệu tạm thời (Fallback).");
    }
  } catch (e) {
    console.log("❌ Lỗi nghiêm trọng trong quá trình Update:", e);
  }
}

/* ===== CRON ===== */
cron.schedule("*/2 * * * *", updateData);

/* ===== API ===== */
app.get("/api/gold", (req, res) => {
  res.json(latestData || {});
});

app.get("/api/history", async (req, res) => {
  const data = await History.find().sort({ createdAt: -1 });
  res.json(data);
});

/* BẢO MẬT: Bắt buộc gửi Header chứa mã Secret để xóa DB */
app.delete("/api/history", async (req, res) => {
  const userKey = req.headers['x-admin-key'];
  if (userKey !== ADMIN_KEY) {
    return res.status(403).json({ error: "Unauthorized" });
  }
  await History.deleteMany({});
  res.json({ ok: true });
});

/* ===== START ===== */
app.listen(PORT, () => {
  console.log("🚀 Server running on", PORT);
  updateData();
});