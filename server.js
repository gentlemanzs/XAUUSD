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

// TỐI ƯU: Gỡ bỏ cache file tĩnh để cập nhật code mới ngay lập tức
app.use(express.static("public")); 

const PORT = process.env.PORT || 3000;

/* ===== CONNECT MONGO ===== */
mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 5000 })
  .then(() => console.log("✅ MongoDB connected"))
  .catch(err => { console.error("❌ MongoDB error:", err); process.exit(1); });

/* ===== SCHEMA ===== */
const HistorySchema = new mongoose.Schema({
  usd: Number, xau: Number, sjc: Number, worldVND: Number,
  diff: Number, percent: String, status: String
}, { timestamps: true });

HistorySchema.index({ createdAt: -1 });
const History = mongoose.model("History", HistorySchema);

// TỐI ƯU: Biến RAM lưu bản ghi gần nhất để làm Fallback (Tránh đọc DB thừa)
let cachedLastRecord = null;
let latestData = null;
let clients = []; 
let lastUpdateTime = 0; 
let isUpdating = false; 

/* ===== FETCH HELPERS ===== */
async function fetchWithRetry(url, isJson = false) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      signal: AbortSignal.timeout(8000) 
    });
    return isJson ? await res.json() : await res.text();
  } catch (e) { return null; }
}

async function updateData(triggerSource = "Tự động") {
  if (isUpdating) return;
  isUpdating = true;
  try {
    console.log(`\n▶ [${triggerSource}] Cập nhật dữ liệu...`);
    
    // TỐI ƯU: Nếu RAM chưa có dữ liệu cũ, chỉ đọc DB duy nhất một lần khi khởi động
    if (!cachedLastRecord) {
      cachedLastRecord = await History.findOne().sort({ createdAt: -1 }).lean();
    }

    const [htmlVCB, dataXAU, htmlSJC] = await Promise.all([
      fetchWithRetry("https://webgia.com/ty-gia/vietcombank/"),
      fetchWithRetry("https://api.gold-api.com/price/XAU", true),
      fetchWithRetry("https://webgia.com/gia-vang/sjc/")
    ]);

    let usd = 1000, xau = 2350, sjc = 0;
    if (htmlVCB) {
      const $ = cheerio.load(htmlVCB);
      const rate = $('td:contains("USD")').parent().find('td').last().text().trim();
      usd = parseFloat(rate.replace(/\./g, "").replace(",", ".")) || 1000;
    }
    xau = dataXAU?.price || 2350;
    if (htmlSJC) {
      const $ = cheerio.load(htmlSJC);
      const priceText = $('td:contains("Vàng SJC 1L")').first().next().next().text().trim();
      sjc = (parseInt(priceText.replace(/\./g, ""), 10) * 10) || 0;
    }

    // TỐI ƯU: Sử dụng cachedLastRecord từ RAM để fallback thay vì findOne()
    if (sjc <= 0 && cachedLastRecord) sjc = cachedLastRecord.sjc;
    if (usd === 1000 && cachedLastRecord) usd = cachedLastRecord.usd;

    if (sjc <= 0 || xau <= 0) return;

    const worldVND = xau * usd * (37.5 / 31.1035);
    const diff = sjc - worldVND;

    latestData = {
      updatedAt: new Date(), usd, xau, sjc,
      worldVND: Math.round(worldVND), diff: Math.round(diff),
      percent: ((diff / worldVND) * 100).toFixed(2) + "%",
      status: sjc > 0 ? "Live" : "Delayed"
    };

    if (sjc > 0 && (!cachedLastRecord || cachedLastRecord.sjc !== sjc)) {
      await History.create(latestData);
      console.log(`💾 Đã lưu lịch sử giá mới: ${sjc}`);
      // Cập nhật RAM cache ngay lập tức
      cachedLastRecord = latestData;
      const count = await History.countDocuments();
      if (count > 200) await History.findOneAndDelete({}, { sort: { createdAt: 1 } });
    }

    clients.forEach(c => c.write(`data: ${JSON.stringify(latestData)}\n\n`));
  } finally {
    isUpdating = false;
    lastUpdateTime = Date.now();
  }
}

/* ===== API & SSE ===== */
app.get("/api/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  clients.push(res);
  req.on("close", () => clients = clients.filter(c => c !== res));
});

app.get("/api/gold", async (req, res) => {
  if (req.query.force === "true" && (Date.now() - lastUpdateTime > 60000)) {
    await updateData("Pull-to-Refresh");
  }
  res.json(latestData || {});
});

app.get("/api/history", async (req, res) => {
  const data = await History.find().sort({ createdAt: -1 }).limit(100).lean();
  res.json(data);
});

app.post("/api/history/bulk-delete", async (req, res) => {
  try {
    const { ids } = req.body;
    await History.deleteMany({ _id: { $in: ids } });
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ error: "Lỗi" }); }
});

cron.schedule("*/15 * * * *", () => updateData("Cronjob"));

app.listen(PORT, () => {
  console.log(`🚀 Server chạy trên port ${PORT}`);
  updateData("Khởi động");
});