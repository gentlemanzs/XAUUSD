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

// TỐI ƯU: Bỏ maxAge để điện thoại không bị dính bộ nhớ đệm CSS/JS cũ
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

// TỐI ƯU: Biến RAM Cache để không phải gọi Database liên tục
let latestData = null;
let clients = []; 
let lastUpdateTime = 0; 
let isUpdating = false; 

/* ===== FETCH HELPERS (Native Fetch Node 18+) ===== */
async function fetchWithRetry(url, isJson = false) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      signal: AbortSignal.timeout(8000) 
    });
    return isJson ? await res.json() : await res.text();
  } catch (e) { return null; }
}

/* ===== UPDATE LOGIC ===== */
async function updateData(triggerSource = "Tự động") {
  if (isUpdating) return;
  isUpdating = true;
  try {
    console.log(`\n▶ [${triggerSource}] Bắt đầu cào dữ liệu lúc ${new Date().toLocaleTimeString('vi-VN')}`);
    
    const [htmlVCB, dataXAU, htmlSJC] = await Promise.all([
      fetchWithRetry("https://webgia.com/ty-gia/vietcombank/"),
      fetchWithRetry("https://api.gold-api.com/price/XAU", true),
      fetchWithRetry("https://webgia.com/gia-vang/sjc/")
    ]);

    // TỐI ƯU: Lấy dữ liệu cũ từ RAM thay vì chọc vào Database
    let lastRecord = latestData; 
    if (!lastRecord) {
      lastRecord = await History.findOne().sort({ createdAt: -1 }).lean();
    }
    
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

    // Fallback nếu webgia lỗi
    if (sjc <= 0 && lastRecord) sjc = lastRecord.sjc;
    if (usd === 1000 && lastRecord) usd = lastRecord.usd;

    if (sjc <= 0 || xau <= 0) return; // Lỗi hoàn toàn thì hủy

    const worldVND = xau * usd * (37.5 / 31.1035);
    const diff = sjc - worldVND;

    // Lưu vào RAM Cache
    latestData = {
      updatedAt: new Date(), usd, xau, sjc,
      worldVND: Math.round(worldVND), diff: Math.round(diff),
      percent: ((diff / worldVND) * 100).toFixed(2) + "%",
      status: sjc > 0 ? "Live" : "Delayed"
    };

    // Chỉ ghi vào DB nếu giá SJC thay đổi
    if (sjc > 0 && (!lastRecord || lastRecord.sjc !== sjc)) {
      const dbEntry = { ...latestData };
      delete dbEntry.updatedAt; // Xóa key thừa trước khi lưu DB
      await History.create(dbEntry);
      console.log(`   💾 DB: Đã lưu bản ghi SJC mới là ${sjc}`);
      
      const count = await History.countDocuments();
      if (count > 200) await History.findOneAndDelete({}, { sort: { createdAt: 1 } });
    } else {
      console.log(`   ⏩ DB: Giá SJC không đổi (${sjc}), không lưu rác.`);
    }

    // Bơm dữ liệu Realtime
    clients.forEach(c => c.write(`data: ${JSON.stringify(latestData)}\n\n`));
    console.log(`   ✅ Đã đẩy Realtime xuống ${clients.length} client(s).`);
  } catch (e) {
    console.log("❌ Lỗi cập nhật:", e);
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

// Ép Force Update với 60s cooldown
app.get("/api/gold", async (req, res) => {
  const force = req.query.force;
  const now = Date.now();
  if (force === "true" && !isUpdating && (now - lastUpdateTime > 60000)) {
    console.log("\n⚡ Nhận yêu cầu Force Update từ Web (F5 hoặc Pull)...");
    await updateData("Pull-to-Refresh");
  } else if (force === "true" && (now - lastUpdateTime <= 60000)) {
    console.log(`⏳ Bỏ qua Force Update: Cooldown còn ${Math.round((60000 - (now - lastUpdateTime))/1000)}s.`);
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
  } catch (error) { res.status(500).json({ error: "Lỗi xóa" }); }
});

/* ===== CRONJOB ===== */
cron.schedule("*/ * * * *", () => updateData("Cronjob"));

/* ===== START ===== */
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  updateData("Khởi động Server");
});