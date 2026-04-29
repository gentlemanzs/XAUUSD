const express = require("express");
const cron = require("node-cron");
const cors = require("cors");
const mongoose = require("mongoose");
const cheerio = require("cheerio");
const compression = require("compression");

const app = express();
app.use(compression());
app.use(cors());
app.use(express.json());

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

/* ===== SCHEMA ===== */
const HistorySchema = new mongoose.Schema({
  usd: Number,
  xau: Number,
  sjc: Number,
  worldVND: Number,
  diff: Number,
  percent: String,
  status: String
}, { timestamps: true });

HistorySchema.index({ createdAt: -1 });
const History = mongoose.model("History", HistorySchema);

let latestData = null;

/* ===== BIẾN SERVER-SENT EVENTS & COOLDOWN ===== */
let clients = []; // Danh sách các tab web đang mở để nhận realtime
let lastUpdateTime = 0; // Thời gian cào dữ liệu gần nhất
let isUpdating = false; // Trạng thái chống gọi chồng chéo

/* ===== HELPER: USER AGENTS ===== */
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
];

function getRandomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/* ===== TỐI ƯU FETCH BẰNG NATIVE FETCH API (NODE 18+) ===== */
async function fetchWithRetry(url, isJson = false, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      // Native Fetch API tự động tối ưu connection pool (Keep-Alive) qua thư viện Undici lõi của Node
      const res = await fetch(url, {
        headers: { 
          "User-Agent": getRandomUA(), 
          "Accept-Language": "vi-VN,vi;q=0.9" 
        },
        signal: AbortSignal.timeout(10000) // Tự hủy nếu request quá 10s
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return isJson ? await res.json() : await res.text();
    } catch (e) {
      console.log(`⚠️ Thử lại lần ${i + 1} cho ${url}...`);
      if (i === retries - 1) return null;
    }
  }
}

async function getUSDRate() {
  try {
    const html = await fetchWithRetry("https://webgia.com/ty-gia/vietcombank/", false);
    if (!html) return 1000;
    const $ = cheerio.load(html);
    const sellPriceText = $('td:contains("USD")').parent().find('td').last().text().trim(); 
    const rate = parseFloat(sellPriceText.replace(/\./g, "").replace(",", "."));
    return isNaN(rate) ? 1000 : rate;
  } catch { return 1000; }
}

async function getWorldGoldPrice() {
  try {
    const data = await fetchWithRetry("https://api.gold-api.com/price/XAU", true);
    return data?.price || 2350;
  } catch { return 2350; }
}

async function getSJCPrice() {
  try {
    const html = await fetchWithRetry("https://webgia.com/gia-vang/sjc/", false);
    if (!html) return 0;
    const $ = cheerio.load(html);
    const nameCell = $('td:contains("Vàng SJC 1L")').first();
    const sellPriceText = nameCell.next().next().text().trim();
    if (sellPriceText) {
      const pricePerChi = parseInt(sellPriceText.replace(/\./g, ""), 10);
      if (!isNaN(pricePerChi)) return pricePerChi * 10;
    }
    return 0;
  } catch { return 0; }
}

/* ===== SAVE LOGIC ===== */
async function saveHistory(entry) {
  try {
    const last = await History.findOne().sort({ createdAt: -1 });
    if (!last || last.sjc !== entry.sjc) {
      await History.create(entry);
      console.log(`   💾 DB: Đã lưu bản ghi SJC mới là ${entry.sjc}`);
      const count = await History.countDocuments();
      if (count > 200) await History.findOneAndDelete({}, { sort: { createdAt: 1 } });
    } else {
      console.log(`   ⏩ DB: Giá SJC không đổi (${entry.sjc}), bỏ qua lưu lịch sử mới.`);
    }
  } catch (e) { console.log("❌ Lỗi lưu DB:", e); }
}

/* ===== UPDATE (HỖ TRỢ REALTIME EVENT) ===== */
// Thêm tham số triggerSource để biết ai gọi lệnh cào (Cron hay Web)
async function updateData(triggerSource = "Tự động") {
  try {
    console.log(`\n▶ [${triggerSource}] Bắt đầu cào dữ liệu lúc ${new Date().toLocaleTimeString('vi-VN')}`);
    
    let [usd, xau, sjc] = await Promise.all([ getUSDRate(), getWorldGoldPrice(), getSJCPrice() ]);
    console.log(`   ↳ Kết quả thô: USD=${usd}, XAU=${xau}, SJC=${sjc}`);

    const lastRecord = await History.findOne().sort({ createdAt: -1 });
    let isFallback = false;

    if (sjc <= 0 && lastRecord) { sjc = lastRecord.sjc; isFallback = true; console.log("   ⚠️ Lỗi cào SJC, dùng fallback."); }
    if (xau <= 0 && lastRecord) { xau = lastRecord.xau; isFallback = true; console.log("   ⚠️ Lỗi cào XAU, dùng fallback."); }
    if (usd === 1000 && lastRecord) { usd = lastRecord.usd; console.log("   ⚠️ Lỗi cào USD, dùng fallback."); }

    if (sjc <= 0 || xau <= 0) {
        console.log("   ❌ Dữ liệu lỗi hoàn toàn (0đ), hủy tiến trình cập nhật.");
        return;
    }

    const worldVND = xau * usd * (37.5 / 31.1035);
    const diff = sjc - worldVND;
    const percent = (diff / worldVND) * 100;

    latestData = {
      updatedAt: new Date(),
      usd: usd, xau: xau, sjc: sjc,
      worldVND: Math.round(worldVND),
      diff: Math.round(diff),
      percent: percent.toFixed(2) + "%",
      status: isFallback ? "Delayed" : "Live"
    };

    // Nếu không xài fallback thì mới lưu DB
    if (!isFallback) {
        await saveHistory(latestData);
    } else {
        console.log(`   ⏩ Đang dùng dữ liệu dự phòng (Fallback), không lưu DB.`);
    }
    
    // ĐẨY DỮ LIỆU REALTIME XUỐNG TẤT CẢ CÁC TRANG WEB ĐANG MỞ
    clients.forEach(client => client.write(`data: ${JSON.stringify(latestData)}\n\n`));
    console.log(`   ✅ Đã đẩy dữ liệu Realtime xuống ${clients.length} client(s) đang mở web.`);
    
  } catch (e) { console.log("❌ Lỗi cập nhật:", e); }
}

/* ===== LOGIC KHUNG GIỜ GIAO DỊCH (GIỮ NGUYÊN BẢN GỐC CỦA BẠN) ===== */
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
    updateData("Cronjob"); // Truyền tên vào
  }
});

/* ===== API CHÍNH ===== */

// 1. ENDPOINT LẮNG NGHE REALTIME (SERVER-SENT EVENTS)
app.get("/api/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  
  clients.push(res);
  req.on("close", () => { clients = clients.filter(c => c !== res); });
});

// 2. ENDPOINT LẤY DỮ LIỆU (CÓ TÍNH NĂNG FORCE UPDATE + COOLDOWN)
app.get("/api/gold", async (req, res) => {
  const force = req.query.force;
  const now = Date.now();
  
  // Kiểm tra: Nếu là force update, không bị kẹt tiến trình cũ, và đã trôi qua hơn 60000ms (1 phút)
  if (force === "true" && !isUpdating && (now - lastUpdateTime > 60000)) {
    console.log("\n⚡ Nhận yêu cầu Force Update từ Web (F5 hoặc Pull)...");
    isUpdating = true;
    await updateData("Pull-to-Refresh"); // Đợi cào xong
    lastUpdateTime = Date.now();
    isUpdating = false;
  } else if (force === "true" && (now - lastUpdateTime <= 60000)) {
    
  }
  
  res.json(latestData || {});
});

app.get("/api/history", async (req, res) => {
  const data = await History.find().sort({ createdAt: -1 }).lean();
  res.json(data);
});

app.post("/api/history/bulk-delete", async (req, res) => {
  try {
    const { ids } = req.body;
    await History.deleteMany({ _id: { $in: ids } });
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ error: "Lỗi xóa" }); }
});

/* ===== START ===== */
app.listen(PORT, () => {
  console.log("🚀 Server đang chạy trên port", PORT);
  updateData("Khởi động Server"); // Lần đầu boot server
});