const express = require("express");
const path = require("path"); 
const cron = require("node-cron");
const cors = require("cors");
const mongoose = require("mongoose");
const cheerio = require("cheerio");
const compression = require("compression");
const rateLimit = require('express-rate-limit');
const app = express();

app.set('trust proxy', 1);

app.use(compression({ level: 6, threshold: 1024 }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 100, 
  message: { error: "Bạn đã gọi API quá nhiều lần. Vui lòng đợi 15 phút." },
  standardHeaders: true, 
  legacyHeaders: false, 
  skip: (req) => req.headers.accept === 'text/event-stream' 
});

app.use(cors());
app.use(express.json({ limit: "10kb" })); 

app.use(express.static(path.join(__dirname, "public"), {
  maxAge: "1d",
  etag: true
}));

app.use('/api/history', apiLimiter);
app.use('/api/gold', apiLimiter);

const PORT = process.env.PORT || 3000;

let latestData = null;
let clients = new Set(); 
let isUpdating = false; 

let lastDifferentSjc = null; 
let cachedLastSavedXau = null; 
let cachedYesterdaySjc = null;
let cachedYesterdayDate = null;
let cachedHistory = [];

// [TỐI ƯU 3.3] Hàm format ngày giờ ngay trên Server để giải phóng CPU cho điện thoại
function formatTimeVN(dateObj) {
  if (!dateObj) return "--";
  return new Date(dateObj).toLocaleString('vi-VN', { 
    timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' 
  });
}

async function preloadCache() {
  try {
    const historyData = await History.find()
      .select("createdAt xau sjc diff percent _id") 
      .sort({ createdAt: -1 })
      .limit(1000)
      .lean();
      
    // Format sẵn thời gian cho toàn bộ Cache RAM
    if (historyData.length > 0) {
      cachedHistory = historyData.map(item => ({
        ...item,
        timeStr: formatTimeVN(item.createdAt) // Ép sẵn string cho Frontend
      }));
    }

    const last = await History.findOne().select('sjc diff xau usd').sort({ createdAt: -1 }).lean();
    if (last) {
      cachedLastSavedXau = last.xau;
      latestData = { sjc: last.sjc, xau: last.xau, usd: last.usd };
      
      const diffRecord = await History.findOne({ sjc: { $ne: last.sjc } }).select('sjc diff').sort({ createdAt: -1 }).lean();
      lastDifferentSjc = diffRecord ? { sjc: diffRecord.sjc, diff: diffRecord.diff } : { sjc: last.sjc, diff: last.diff };
      console.log(`📦 Đã nạp (Preload) toàn bộ ${historyData.length} dòng History (tinh gọn) lên RAM!`);
    }
  } catch (e) {
    console.log("⚠️ Khởi động: Lỗi preload cache:", e.message);
  }
}

mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 5000, maxPoolSize: 10, minPoolSize: 2 })
  .then(async () => { 
    console.log("✅ MongoDB connected");
    await preloadCache(); 
    
    // [TỐI ƯU 3.8] Cấu hình HTTP Keep-Alive chống lag mạng
    const server = app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      updateData("Khởi động Server");
    });
    server.keepAliveTimeout = 65000;
    server.headersTimeout = 66000;
  })
  .catch(err => { console.error("❌ MongoDB error:", err); process.exit(1); });

mongoose.connection.on('error', (err) => { console.error("🔥 Lỗi Mất Kết Nối MongoDB:", err); });
mongoose.connection.on('disconnected', () => { console.warn("⚠️ MongoDB đã ngắt kết nối. Đang thử lại..."); });

const HistorySchema = new mongoose.Schema({
  usd: Number, xau: Number, sjc: Number, worldVND: Number, diff: Number, percent: String, status: String
}, { timestamps: true });

HistorySchema.index({ createdAt: -1, sjc: 1 });
HistorySchema.index({ createdAt: -1 });
const History = mongoose.model("History", HistorySchema);

// Xử lý dọn rác Client chết (không dùng setTimeout 30s)
setInterval(() => {
  for (const c of clients) {
    try { c.write(":\n\n"); if (typeof c.flush === "function") c.flush(); } 
    catch (e) { clients.delete(c); }
  }
}, 20000); 

let cachedUsdRate = null; 
let lastUsdFetchTime = 0;
const USD_CACHE_DURATION = 60 * 60 * 1000; 

function isVietnamTradingTime() {
  const now = new Date();
  const vnTimeStr = now.toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" });
  const vnTime = new Date(vnTimeStr);
  const day = vnTime.getDay(); 
  const hour = vnTime.getHours();
  const min = vnTime.getMinutes();
  const timeInMinutes = hour * 60 + min;

  if (day === 0) return false;
  if (day >= 1 && day <= 5) return timeInMinutes >= 510 && timeInMinutes <= 1050;
  if (day === 6) return timeInMinutes >= 510 && timeInMinutes <= 630;
  return false;
}

async function fetchWithRetry(url, isJson = false, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        signal: AbortSignal.timeout(5000), keepalive: true 
      });
      if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);
      return isJson ? await res.json() : await res.text();
    } catch (e) {
      if (i === retries - 1) return null; 
      await new Promise(r => setTimeout(r, 300 * (i + 1)));
    }
  }
}

async function getUsdRate() {
  const now = Date.now();
  if (now - lastUsdFetchTime < USD_CACHE_DURATION && cachedUsdRate !== null) return cachedUsdRate;
  const xml = await fetchWithRetry("https://portal.vietcombank.com.vn/Usercontrols/TVPortal.TyGia/pXML.aspx");
  if (xml) {
    const $ = cheerio.load(xml, { xmlMode: true });
    const sellStr = $('Exrate[CurrencyCode="USD"]').attr('Sell');
    if (sellStr) {
      const parsedRate = parseFloat(sellStr.replace(/,/g, ""));
      if (!isNaN(parsedRate)) {
        cachedUsdRate = parsedRate; lastUsdFetchTime = now;
        return cachedUsdRate;
      }
    }
  }
  return cachedUsdRate; 
}

async function getSjcPrice() {
  try {
    const dojiXml = await fetchWithRetry("https://giavang.doji.vn/api/giavang/?api_key=258fbd2a72ce8481089d88c678e9fe4f", false);
    if (dojiXml) {
      const $ = cheerio.load(dojiXml, { xmlMode: true });
      const sellStr = $('Row[Key="dojihanoile"]').attr('Sell');
      if (sellStr) {
        let price = parseFloat(sellStr.replace(/,/g, ""));
        if (price > 0 && price < 1000000) price *= 1000; 
        return price;
      }
    }
  } catch (err) {}

  try {
    const btmcXml = await fetchWithRetry("http://api.btmc.vn/api/BTMCAPI/getpricebtmc?key=3kd8ub1llcg9t45hnoh8hmn7t5kc2v", false);
    if (btmcXml) {
      const $ = cheerio.load(btmcXml, { xmlMode: true });
      const sellStr = $('Data[row="932"]').attr('ps_932');
      if (sellStr) {
        let price = parseFloat(sellStr.replace(/,/g, ""));
        if (price > 0 && price < 1000000) price *= 1000; 
        return price;
      }
    }
  } catch (err) {}
  return 0; 
}

async function updateData(triggerSource = "Tự động") {
  if (isUpdating) return; 
  isUpdating = true;
  try {
    const isTrading = isVietnamTradingTime();
    
    const [usdRate, dataXAU, sjcPrice] = await Promise.all([
      isTrading ? getUsdRate() : Promise.resolve(null),
      fetchWithRetry("https://api.gold-api.com/price/XAU", true),
      isTrading ? getSjcPrice() : Promise.resolve(0)
    ]);

    let lastRecord = latestData; 
    if (!lastRecord) lastRecord = await History.findOne().select('usd xau sjc').sort({ createdAt: -1 }).lean().catch(() => null);
    
    const isSjcLive = sjcPrice > 0;
    const isXauLive = !!(dataXAU && dataXAU.price);
    const isUsdLive = usdRate !== null;

    let sjc = isSjcLive ? sjcPrice : (lastRecord ? lastRecord.sjc : 0);
    let xau = isXauLive ? dataXAU.price : (lastRecord ? lastRecord.xau : 2350);
    let usd = isUsdLive ? usdRate : (lastRecord ? lastRecord.usd : 25400); 

    if (sjc <= 0 || xau <= 0) {
        if (latestData) {
          latestData.status = "Delayed (Lỗi hệ thống)";
          const fallbackPayload = `data: ${JSON.stringify(latestData)}\n\n`;
          for (const c of clients) { try { c.write(fallbackPayload); if (typeof c.flush === "function") c.flush(); } catch (err) { clients.delete(c); } }
        }
        return; 
    }

    const worldVND = xau * usd * (37.5 / 31.1035);
    const diff = sjc - worldVND;
    const currentGap = Math.round(diff);

    const todayStr = new Date().toDateString();
    if (cachedYesterdayDate !== todayStr || cachedYesterdaySjc === null) {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      yesterday.setHours(23, 59, 59, 999);
      const lastDayRecord = await History.findOne({ createdAt: { $lte: yesterday } }).select('sjc').sort({ createdAt: -1 }).lean().catch(() => null);
      cachedYesterdaySjc = lastDayRecord ? lastDayRecord.sjc : sjc;
      cachedYesterdayDate = todayStr;
    }
    const sjcChange = sjc - cachedYesterdaySjc;

    if (!lastDifferentSjc) {
      const record = await History.findOne({ sjc: { $ne: sjc } }).select('sjc diff').sort({ createdAt: -1 }).lean().catch(() => null);
      lastDifferentSjc = record ? { sjc: record.sjc, diff: record.diff } : { sjc: sjc, diff: currentGap };
    }
    const gapChange = lastDifferentSjc.diff - currentGap;

    if (cachedLastSavedXau === null) {
      const latestDbRecord = await History.findOne().select('xau').sort({ createdAt: -1 }).lean().catch(() => null);
      cachedLastSavedXau = latestDbRecord ? latestDbRecord.xau : xau;
    }
    const xauChange = xau - cachedLastSavedXau;

    let failedAPIs = [];
    if (!isTrading) failedAPIs.push("Ngoài giờ GD");
    else {
      if (!isSjcLive) failedAPIs.push("SJC Lỗi");
      if (!isUsdLive) failedAPIs.push("USD Lỗi");
    }
    if (!isXauLive) failedAPIs.push("XAU Lỗi");

    let currentStatus = failedAPIs.length === 0 ? "Live" : `Delayed (${failedAPIs.join(", ")})`;
    const updatedTimeObj = new Date();

    latestData = {
      updatedAt: updatedTimeObj, 
      timeStr: formatTimeVN(updatedTimeObj), // Định dạng sẵn giờ để Client không phải lo
      usd, xau, xauChange, sjc, sjcChange, oldGap: lastDifferentSjc.diff,       
      gapChange, worldVND: Math.round(worldVND), diff: currentGap,
      percent: ((diff / worldVND) * 100).toFixed(2) + "%", status: currentStatus 
    };

    if (sjc > 0 && (!lastRecord || lastRecord.sjc !== sjc)) {
      const dbEntry = { ...latestData };
      delete dbEntry.updatedAt; delete dbEntry.timeStr; 
      const savedDoc = await History.create(dbEntry);
      
      cachedLastSavedXau = xau;
      lastDifferentSjc = { sjc: sjc, diff: currentGap };
   
      const slimDoc = {
        createdAt: savedDoc.createdAt,
        timeStr: formatTimeVN(savedDoc.createdAt), // Gắn sẵn text giờ vào RAM Cache
        xau: savedDoc.xau, sjc: savedDoc.sjc, diff: savedDoc.diff,
        percent: savedDoc.percent, _id: savedDoc._id
      };
      cachedHistory.unshift(slimDoc);
      if (cachedHistory.length > 1000) cachedHistory.pop(); 

      try {
        const overflowRecord = await History.findOne().sort({ createdAt: -1 }).skip(1000).select('createdAt').lean();
        if (overflowRecord?.createdAt) await History.deleteMany({ createdAt: { $lt: overflowRecord.createdAt } });
      } catch (err) {}
    }

    const ssePayload = `data: ${JSON.stringify(latestData)}\n\n`;
    for (const c of clients) {
      try { c.write(ssePayload); if (typeof c.flush === "function") c.flush(); } 
      catch (err) { clients.delete(c); }
    }
  } catch (e) {
  } finally {
    isUpdating = false;
  }
}

app.get("/api/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  
  if (clients.size > 1000) {
    let i = 0;
    for (const c of clients) {
      if (i >= clients.size - 500) break;
      try { c.end(); } catch (e) {}
      clients.delete(c); i++;
    }
  }
  clients.add(res);
  if (latestData) {
      res.write(`data: ${JSON.stringify(latestData)}\n\n`);
      if (typeof res.flush === "function") res.flush();
  }
  req.on("close", () => { clients.delete(res); try { res.end(); } catch {} });
});

app.get("/api/gold", async (req, res) => {
    // [TỐI ƯU 3.5] Thêm Micro-cache để giảm Burst Request
    res.setHeader('Cache-Control', 'public, max-age=1');
    res.json(latestData || {});
});

app.get("/api/history", async (req, res) => {
  // [TỐI ƯU 3.1 & 2.2] Hỗ trợ Load 1 phần dữ liệu để giảm dung lượng mạng (Mặc định 50, nếu cần lấy max 1000)
  const limit = parseInt(req.query.limit) || 50;
  if (cachedHistory.length > 0) {
    return res.json(cachedHistory.slice(0, limit));
  }
  
  const data = await History.find().select("createdAt xau sjc diff percent _id").sort({ createdAt: -1 }).limit(1000).lean();
  cachedHistory = data.map(item => ({...item, timeStr: formatTimeVN(item.createdAt)}));
  res.json(cachedHistory.slice(0, limit));
});

app.post("/api/history/bulk-delete", async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids)) return res.status(400).json({ error: "Thiếu danh sách ID" });
    await History.deleteMany({ _id: { $in: ids } });
    
    // [TỐI ƯU 1.3] Xóa mảng thông minh, tránh xóa trắng rồi bắt Server Query lại 1000 dòng
    cachedHistory = cachedHistory.filter(item => !ids.includes(item._id.toString()));
    
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ error: "Lỗi xóa" }); }
});

// [TỐI ƯU 3.7] Lên lịch cào: Trong giờ GD cào mỗi 1 phút (Để an toàn IP). Ngoài giờ cào 5 phút.
cron.schedule("* * * * *", () => {
  const isTrading = isVietnamTradingTime();
  const currentMinute = new Date().getMinutes();
  
  if (isTrading) {
    updateData("Cronjob 1 phút (Giờ GD)");
  } else if (currentMinute % 5 === 0) {
    updateData("Cronjob 5 phút (Ngoài giờ GD)");
  }
});