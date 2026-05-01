const express = require("express");
const path = require("path"); 
const cron = require("node-cron");
const cors = require("cors");
const mongoose = require("mongoose");
const cheerio = require("cheerio");
const compression = require("compression");
const app = express();

app.set('trust proxy', 1);
app.use(compression({ level: 6, threshold: 1024 }));

app.use(cors());
app.use(express.json({ limit: "10kb" })); 

app.use(express.static(path.join(__dirname, "public"), {
  maxAge: "1d",
  etag: true
}));

const PORT = process.env.PORT || 3000;

let latestData = null;
let clients = new Set(); 
let isUpdating = false; 

let lastDifferentSjc = null; 
let cachedLastSavedXau = null; 
let cachedYesterdaySjc = null;
let cachedYesterdayDate = null;
let cachedHistory = [];

function formatTimeVN(dateObj) {
  if (!dateObj) return "--";
  const pad = n => String(n).padStart(2, '0');
  const vn = new Date(new Date(dateObj).toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
  return `${pad(vn.getDate())}/${pad(vn.getMonth()+1)} ${pad(vn.getHours())}:${pad(vn.getMinutes())}`;
}

// ─── TELEGRAM ALERT ──────────────────────────────────────────────────────
const TG_TOKEN   = process.env.TG_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const ALERT_COOLDOWN_MS = 10 * 60 * 1000; // 10 phút — chống spam cùng 1 lỗi
const alertCooldowns = new Map();

async function sendTelegram(message, alertKey) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  const lastSent = alertCooldowns.get(alertKey) || 0;
  if (Date.now() - lastSent < ALERT_COOLDOWN_MS) return;
  alertCooldowns.set(alertKey, Date.now());
  const text = `🚨 *XAU Alert*\n${message}\n\n⏰ ${new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}`;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'Markdown' }),
      signal: AbortSignal.timeout(5000)
    });
  } catch (e) {
    console.error('❌ Gửi Telegram thất bại:', e.message);
  }
}
// ──────────────────────────────────────────────────────────────────────────

function logApiError(apiName, attempt, error) {
  const ts = new Date().toISOString();
  console.warn(`⚠️  [${ts}] API "${apiName}" thất bại (lần ${attempt}): ${error.message}`);
}

const HistorySchema = new mongoose.Schema({
  usd: Number, xau: Number, sjc: Number, worldVND: Number, diff: Number, percent: String, status: String
}, { timestamps: true });

HistorySchema.index({ createdAt: -1, sjc: 1 });
const History = mongoose.model("History", HistorySchema);

async function preloadCache() {
  try {
    const historyData = await History.find()
      .select("createdAt xau sjc diff percent _id") 
      .sort({ createdAt: -1 })
      .limit(1000)
      .lean();
      
    if (historyData.length > 0) {
      for (const item of historyData) {
        item.timeStr = formatTimeVN(item.createdAt);
        // Fix điểm 2: Thêm filterDateStr ngay từ lúc preload cache
        item.filterDateStr = new Date(item.createdAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
      }
      cachedHistory = historyData;
    }

    const last = await History.findOne().select('sjc diff xau usd').sort({ createdAt: -1 }).lean();
    if (last) {
      cachedLastSavedXau = last.xau;
      latestData = { sjc: last.sjc, xau: last.xau, usd: last.usd };
      const diffRecord = await History.findOne({ sjc: { $ne: last.sjc } }).select('sjc diff').sort({ createdAt: -1 }).lean();
      lastDifferentSjc = diffRecord ? { sjc: diffRecord.sjc, diff: diffRecord.diff } : { sjc: last.sjc, diff: last.diff };
      console.log(`📦 Đã nạp (Preload) toàn bộ ${historyData.length} dòng History lên RAM.`);
    }
  } catch (e) {
    console.log("⚠️ Khởi động: Lỗi preload cache:", e.message);
  }
}

mongoose.connect(process.env.MONGO_URI, { 
  serverSelectionTimeoutMS: 5000, 
  maxPoolSize: 10, 
  minPoolSize: 2,
  heartbeatFrequencyMS: 10000 
})
  .then(async () => { 
    console.log("✅ MongoDB connected");
    await preloadCache(); 
    
    const server = app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      sendTelegram("🚀 Bot Telegram đã kết nối!", "server_start");
      updateData("Khởi động Server");
    });
    server.keepAliveTimeout = 65000;
    server.headersTimeout = 66000;
  })
  .catch(err => {
  console.error("❌ MongoDB error:", err);
  sendTelegram(`❌ *MongoDB kết nối thất bại*\nLỗi: ${err.message}`, "mongo_connect");
  process.exit(1);
});

mongoose.connection.on('error', (err) => {
  console.error("🔥 Lỗi Mất Kết Nối MongoDB:", err);
  sendTelegram(`🔥 *MongoDB mất kết nối*\nLỗi: ${err.message}`, "mongo_runtime");
});

setInterval(() => {
  for (const c of [...clients]) {
    try { c.write(":\n\n"); if (typeof c.flush === "function") c.flush(); } 
    catch (e) { clients.delete(c); }
  }
}, 40000); 

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

// Forex (XAU, USD) đóng cửa từ 5:30 thứ 7 đến 5:00 thứ 2 (GMT+7)
function isForexMarketOpen() {
  const now = new Date();
  const vnTimeStr = now.toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" });
  const vnTime = new Date(vnTimeStr);
  const day = vnTime.getDay();
  const timeInMinutes = vnTime.getHours() * 60 + vnTime.getMinutes();

  if (day === 0) return false;                              // Chủ nhật: đóng cả ngày
  if (day === 6 && timeInMinutes >= 330) return false;      // Thứ 7 từ 5:30 trở đi: đóng
  if (day === 1 && timeInMinutes < 300) return false;       // Thứ 2 trước 5:00: đóng
  return true;
}

async function fetchWithRetry(url, isJson = false, retries = 2) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
        signal: AbortSignal.timeout(5000), keepalive: true 
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return isJson ? await res.json() : await res.text();
    } catch (e) {
      logApiError(url, i + 1, e);
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
    console.warn(`⚠️  [${new Date().toISOString()}] Vietcombank XML: không tìm thấy tỷ giá USD`);
  }
  return cachedUsdRate; 
}

async function getPriceFromXml(url, selector, attrName) {
  try {
    const xml = await fetchWithRetry(url, false);
    if (!xml) return 0;
    const $ = cheerio.load(xml, { xmlMode: true });
    const sellStr = $(selector).attr(attrName);
    if (sellStr) {
      let price = parseFloat(sellStr.replace(/,/g, ""));
      if (price > 0 && price < 1000000) price *= 1000; 
      return price;
    }
  } catch (err) {
    console.warn(`⚠️ [${new Date().toISOString()}] Parse lỗi từ ${url}: ${err.message}`);
  }
  return 0;
}

async function getSjcPrice() {
  // Ưu tiên DOJI, fallback sang BTMC
  let price = await getPriceFromXml("https://giavang.doji.vn/api/giavang/?api_key=258fbd2a72ce8481089d88c678e9fe4f", 'Row[Key="dojihanoile"]', 'Sell');
  if (price > 0) return price;

  price = await getPriceFromXml("http://api.btmc.vn/api/BTMCAPI/getpricebtmc?key=3kd8ub1llcg9t45hnoh8hmn7t5kc2v", 'Data[row="932"]', 'ps_932');
  if (price > 0) return price;

  console.error(`❌ [${new Date().toISOString()}] getSjcPrice: Cả 2 nguồn DOJI và BTMC đều thất bại`);
  return 0; 
}

async function updateData(triggerSource = "Tự động") {
  if (isUpdating) return; 
  isUpdating = true;
  try {
    const isTrading = isVietnamTradingTime();
    const isForex = isForexMarketOpen();
    
    const [usdRate, dataXAU, sjcPrice] = await Promise.all([
      isForex ? getUsdRate() : Promise.resolve(null),
      isForex ? fetchWithRetry("https://api.gold-api.com/price/XAU", true) : Promise.resolve(null),
      isTrading ? getSjcPrice() : Promise.resolve(0)
    ]);

    let lastRecord = latestData; 
    if (!lastRecord) lastRecord = await History.findOne().select('usd xau sjc').sort({ createdAt: -1 }).lean().catch(() => null);
    
    const isSjcLive = sjcPrice > 0;
    const isXauLive = !!(dataXAU && dataXAU.price);
    const isUsdLive = usdRate !== null;

    // Alert Telegram khi từng nguồn API bị fail
    if (isForex && !isXauLive) sendTelegram(`⚠️ *API giá vàng thế giới (XAU) thất bại*\nKhông lấy được giá từ gold-api.com`, 'api_xau');
    if (isForex && !isUsdLive) sendTelegram(`⚠️ *API tỷ giá USD thất bại*\nKhông lấy được tỷ giá từ Vietcombank`, 'api_usd');
    if (isTrading && !isSjcLive) sendTelegram(`⚠️ *API giá SJC thất bại*\nCả DOJI lẫn BTMC đều không trả được giá`, 'api_sjc');

    let sjc = isSjcLive ? sjcPrice : (lastRecord ? lastRecord.sjc : 0);
    let xau = isXauLive ? dataXAU.price : (lastRecord ? lastRecord.xau : 2350);
    let usd = isUsdLive ? usdRate : (lastRecord ? lastRecord.usd : 25400); 

    if (sjc <= 0 || xau <= 0) {
        if (latestData) {
          latestData.status = "Delayed (Lỗi hệ thống)";
          latestData.failedAPIs = ["SYSTEM"]; 
          const fallbackPayload = `data: ${JSON.stringify(latestData)}\n\n`;
          for (const c of [...clients]) { try { c.write(fallbackPayload); if (typeof c.flush === "function") c.flush(); } catch (err) { clients.delete(c); } }
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
    if (isTrading && !isSjcLive) failedAPIs.push("SJC");
    if (isForex && !isUsdLive) failedAPIs.push("USD");
    if (isForex && !isXauLive) failedAPIs.push("XAU");

    let currentStatus = failedAPIs.length === 0 ? "Live" : `Delayed (Lỗi: ${failedAPIs.join(", ")})`;

    const updatedTimeObj = new Date();

    latestData = {
      updatedAt: updatedTimeObj, timeStr: formatTimeVN(updatedTimeObj), 
      usd, xau, xauChange, sjc, sjcChange, oldGap: lastDifferentSjc.diff,       
      gapChange, worldVND: Math.round(worldVND), diff: currentGap,
      percent: ((diff / worldVND) * 100).toFixed(2) + "%", status: currentStatus,
      failedAPIs: failedAPIs
    };

    if (sjc > 0 && (!lastRecord || lastRecord.sjc !== sjc)) {
      const dbEntry = { ...latestData };
      delete dbEntry.updatedAt; delete dbEntry.timeStr; delete dbEntry.failedAPIs;
      const savedDoc = await History.create(dbEntry);
      
      cachedLastSavedXau = xau;
      lastDifferentSjc = { sjc: sjc, diff: currentGap };
   
      const slimDoc = {
        createdAt: savedDoc.createdAt, timeStr: formatTimeVN(savedDoc.createdAt),
        filterDateStr: new Date(savedDoc.createdAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }),
        xau: savedDoc.xau, sjc: savedDoc.sjc, diff: savedDoc.diff,
        percent: savedDoc.percent, _id: savedDoc._id
      };
      cachedHistory.unshift(slimDoc);
    }

    if (process.env.NODE_ENV !== 'production') {
      console.log(`✅ [${currentStatus}] XAU: ${xau} | SJC: ${sjc} | GAP: ${currentGap}`);
    }

    const ssePayload = `data: ${JSON.stringify(latestData)}\n\n`;
    for (const c of [...clients]) {
      try { c.write(ssePayload); if (typeof c.flush === "function") c.flush(); } 
      catch (err) { clients.delete(c); }
    }
  } catch (e) {
    if (process.env.NODE_ENV !== 'production') {
      console.error(`❌ updateData [${triggerSource}] lỗi lúc ${new Date().toISOString()}:`);
      console.error(e);
    } else {
      console.error(`❌ updateData [${triggerSource}] lỗi lúc ${new Date().toISOString()}: ${e.message}`);
    }
  } finally {
    isUpdating = false;
  }
}

app.get("/api/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
    
  clients.add(res);
  if (latestData) {
      res.write(`data: ${JSON.stringify(latestData)}\n\n`);
      if (typeof res.flush === "function") res.flush();
  }
  
  req.on("close", () => { clients.delete(res); });
});

app.get("/api/gold", async (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=1');
    res.json(latestData || {});
});

app.get("/api/history", async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 1000);
  if (cachedHistory.length > 0) return res.json(cachedHistory.slice(0, limit));
  try {
    const data = await History.find().select("createdAt xau sjc diff percent _id").sort({ createdAt: -1 }).limit(1000).lean();
    for (const item of data) {
      item.timeStr = formatTimeVN(item.createdAt);
      item.filterDateStr = new Date(item.createdAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
    }
    cachedHistory = data;
    res.json(cachedHistory.slice(0, limit));
  } catch (e) {
    console.error('❌ /api/history lỗi:', e.message);
    res.status(500).json({ error: "Lỗi tải lịch sử" });
  }
});

app.post("/api/history/bulk-delete", async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids)) return res.status(400).json({ error: "Thiếu danh sách ID" });
    await History.deleteMany({ _id: { $in: ids } });
    cachedHistory = cachedHistory.filter(item => !ids.includes(item._id.toString()));
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ error: "Lỗi xóa" }); }
});

app.post("/api/alert", async (req, res) => {
  try {
    const { message, key } = req.body;
    if (!message || typeof message !== 'string') return res.status(400).json({ error: "Thiếu message" });
    const safeKey = (typeof key === 'string' && key) ? key : 'client_alert';
    await sendTelegram(`📱 *Client Error*\n${message.slice(0, 500)}`, safeKey);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "Lỗi gửi alert" }); }
});

cron.schedule("* * * * *", () => {
  const isTrading = isVietnamTradingTime();
  const currentMinute = new Date().getMinutes();
  
  if (isTrading) {
    updateData("Cronjob 1 phút");
  } else if (currentMinute % 5 === 0) {
    updateData("Cronjob 5 phút");
  }
});