// ============================================================================
// PHẦN 1: KHỞI TẠO THƯ VIỆN & CẤU HÌNH SERVER
// ============================================================================
const express = require("express");
const path = require("path");
const cron = require("node-cron");
const mongoose = require("mongoose");
const cheerio = require("cheerio");
const compression = require("compression");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const app = express();

// Bật Helmet bảo vệ Header
app.use(helmet()); 

// Cấu hình Rate Limit
const syncLimiter = rateLimit({
  windowMs: 60 * 1000, 
  max: 5,
  message: { error: "Bạn thao tác quá nhanh, vui lòng đợi 1 phút!" },
  standardHeaders: true,
  legacyHeaders: false,
});

const deleteLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, 
  max: 5, 
  message: { error: "Thử sai mật khẩu quá nhiều lần. Tạm khóa 5 phút." },
});

app.set('trust proxy', 1);
app.use(compression({ level: 6, threshold: 1024 }));
app.use(express.json({ limit: "10kb" })); 

app.use(express.static(path.join(__dirname, "public"), {
  maxAge: "1d",
  etag: true
}));

const PORT = process.env.PORT || 3000;

// ============================================================================
// PHẦN 2: HỆ THỐNG CACHE IN-MEMORY (LƯU TRÊN RAM)
// ============================================================================
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
  return `${pad(vn.getDate())}/${pad(vn.getMonth() + 1)} ${pad(vn.getHours())}:${pad(vn.getMinutes())}`;
}

// ============================================================================
// PHẦN 3: CẢNH BÁO TELEGRAM (BOT)
// ============================================================================
const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const ALERT_COOLDOWN_MS = 10 * 60 * 1000; 
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

function logApiError(apiName, attempt, error) {
  const ts = new Date().toISOString();
  console.warn(`⚠️  [${ts}] API "${apiName}" thất bại (lần ${attempt}): ${error.message}`);
}

// ============================================================================
// PHẦN 4: KẾT NỐI DATABASE VÀ PRELOAD
// ============================================================================
const HistorySchema = new mongoose.Schema({
  usd: Number, xau: Number, sjc: Number, worldVND: Number, diff: Number, percent: String, status: String
}, { timestamps: true });

HistorySchema.index({ createdAt: -1, sjc: 1 });
const History = mongoose.model("History", HistorySchema);

async function preloadCache() {
  try {
    const historyData = await History.find()
      .select("createdAt xau sjc diff percent usd _id")
      .sort({ createdAt: -1 }).limit(1000).lean();

    if (historyData.length > 0) {
      for (const item of historyData) {
        item.timeStr = formatTimeVN(item.createdAt);
        item.filterDateStr = new Date(item.createdAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
      }
      cachedHistory = historyData;

      const last = historyData[0]; 
      cachedLastSavedXau = last.xau;
      latestData = {
        sjc: last.sjc,
        xau: last.xau,
        usd: last.usd,        
        diff: last.diff,          // FIX UI: Điền đủ placeholder cho 차t mượt
        percent: last.percent,    
        worldVND: Math.round(last.xau * last.usd * (37.5 / 31.1035)),
        gapChange: 0, 
        sjcChange: 0, 
        xauChange: 0,
        status: "Đang khởi động...", 
        failedAPIs: [],
        updatedAt: new Date(), timeStr: formatTimeVN(new Date())
      };

      let diffRecord = historyData.find(r => r.sjc !== last.sjc);
      if (!diffRecord) {
        diffRecord = await History.findOne({ sjc: { $ne: last.sjc } }).select('sjc diff').sort({ createdAt: -1 }).lean();
      }

      lastDifferentSjc = diffRecord ? { sjc: diffRecord.sjc, diff: diffRecord.diff } : { sjc: last.sjc, diff: last.diff };
      console.log(`📦 Đã nạp (Preload) toàn bộ ${historyData.length} dòng History lên RAM.`);
    } else {
      console.log(`⚠️ Database rỗng, chờ cào dữ liệu mới...`);
    }
  } catch (e) {
    console.log("⚠️ Khởi động: Lỗi preload cache:", e.message);
  }
}

mongoose.connect(process.env.MONGO_URI, {
  serverSelectionTimeoutMS: 5000, maxPoolSize: 10, minPoolSize: 2, heartbeatFrequencyMS: 10000
}).then(async () => {
    console.log("✅ MongoDB connected");
    await preloadCache(); 

    const server = app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      sendTelegram("🚀 Bot Telegram đã kết nối!", "server_start");
      updateData("Khởi động Server"); 
    });
    server.keepAliveTimeout = 65000;
    server.headersTimeout = 66000;
}).catch(err => {
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
    try { 
      if (!c.writable || c.writableEnded) { clients.delete(c); continue; }
      c.write(":\n\n"); 
      if (typeof c.flush === "function") c.flush(); 
    }
    catch (e) { clients.delete(c); }
  }
}, 40000);

// ============================================================================
// PHẦN 5: XỬ LÝ NGUỒN CÀO DATA
// ============================================================================
let cachedUsdRate = null;
let lastUsdFetchTime = 0;
const USD_CACHE_DURATION = 60 * 60 * 1000; 

function isVietnamTradingTime() {
  const now = new Date();
  const vnTimeStr = now.toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" });
  const vnTime = new Date(vnTimeStr);
  const day = vnTime.getDay();
  const timeInMinutes = vnTime.getHours() * 60 + vnTime.getMinutes();
  if (day === 0) return false; 
  if (day >= 1 && day <= 5) return timeInMinutes >= 510 && timeInMinutes <= 1020; 
  if (day === 6) return timeInMinutes >= 510 && timeInMinutes <= 630; 
  return false;
}

function isForexMarketOpen() {
  const now = new Date();
  const vnTimeStr = now.toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" });
  const vnTime = new Date(vnTimeStr);
  const day = vnTime.getDay();
  const timeInMinutes = vnTime.getHours() * 60 + vnTime.getMinutes();
  if (day === 0) return false;                              
  if (day === 1 && timeInMinutes < 330) return false;       
  if (day === 6 && timeInMinutes >= 300) return false;      
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
  } catch (err) { }
  return 0;
}

async function getSjcPrice() {
  let price = await getPriceFromXml("https://giavang.doji.vn/api/giavang/?api_key=258fbd2a72ce8481089d88c678e9fe4f", 'Row[Key="dojihanoile"]', 'Sell');
  if (price > 0) return price;
  price = await getPriceFromXml("http://api.btmc.vn/api/BTMCAPI/getpricebtmc?key=3kd8ub1llcg9t45hnoh8hmn7t5kc2v", 'Data[row="932"]', 'ps_932');
  if (price > 0) return price;
  return 0;
}

// ============================================================================
// PHẦN 6: HÀM CỐT LÕI (CALCULATION & SYNC DATABASE)
// ============================================================================
async function updateData(triggerSource = "Tự động", forceFetch = false) {
  if (isUpdating) return; 
  isUpdating = true;
  try {
    const isTrading = forceFetch || isVietnamTradingTime();
    const isForex = forceFetch || isForexMarketOpen();

    const [usdRate, dataXAU, sjcPrice] = await Promise.all([
      isTrading ? getUsdRate() : Promise.resolve(null),
      isForex ? fetchWithRetry("https://api.gold-api.com/price/XAU", true) : Promise.resolve(null),
      isTrading ? getSjcPrice() : Promise.resolve(0)
    ]);

    let lastRecord = latestData;
    if (!lastRecord) lastRecord = await History.findOne().select('usd xau sjc').sort({ createdAt: -1 }).lean().catch(() => null);

    const isSjcLive = sjcPrice > 0;
    const isXauLive = !!(dataXAU && dataXAU.price);
    const isUsdLive = usdRate !== null;

    if (isForex && !isXauLive) sendTelegram(`⚠️ *API giá vàng thế giới (XAU) thất bại*\nKhông lấy được giá từ gold-api.com`, 'api_xau');
    if (isTrading && !isUsdLive) sendTelegram(`⚠️ *API tỷ giá USD thất bại*\nKhông lấy được tỷ giá từ Vietcombank`, 'api_usd');
    if (isTrading && !isSjcLive) sendTelegram(`⚠️ *API giá SJC thất bại*\nCả DOJI lẫn BTMC đều không trả được giá`, 'api_sjc');

    let sjc = isSjcLive ? sjcPrice : (lastRecord ? lastRecord.sjc : 0);
    let xau = isXauLive ? dataXAU.price : (lastRecord ? lastRecord.xau : 0); 
    let usd = isUsdLive ? usdRate : (lastRecord ? lastRecord.usd : 0); 

    if (sjc <= 0 || xau <= 0 || usd <= 0) {
      if (latestData) {
        latestData.status = "Delayed (Lỗi hệ thống - Thiếu dữ liệu)";
        latestData.failedAPIs = ["SYSTEM_DATA_MISSING"];
        const fallbackPayload = `data: ${JSON.stringify(latestData)}\n\n`;
        for (const c of [...clients]) { 
          try { 
            c.write(fallbackPayload); 
            if (typeof c.flush === "function") c.flush(); 
          } catch (err) { 
            clients.delete(c); 
          } 
        }
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

      let lastDayRecord = cachedHistory.find(r => new Date(r.createdAt) <= yesterday);
      if (!lastDayRecord) {
        lastDayRecord = await History.findOne({ createdAt: { $lte: yesterday } }).select('sjc').sort({ createdAt: -1 }).lean().catch(() => null);
      }

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
    if (isTrading && !isUsdLive) failedAPIs.push("USD");
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

    // CHỈ LƯU VÀO DATABASE NẾU SJC CÓ SỰ THAY ĐỔI
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

      if (cachedHistory.length > 1000) {
        cachedHistory.length = 1000;
      }
    }

    const ssePayload = `data: ${JSON.stringify(latestData)}\n\n`;
    for (const c of [...clients]) {
      try { 
        if (!c.writable || c.writableEnded) {
            clients.delete(c); continue;
        }
        c.write(ssePayload); 
        if (typeof c.flush === "function") c.flush(); 
      } 
      catch (err) { clients.delete(c); }
    }
  } catch (e) {
    console.error('[updateData] Lỗi nghiêm trọng:', e.message);
    sendTelegram(`🔥 *Lỗi Runtime (updateData)*\nChi tiết: ${e.message}`, 'update_fatal');
  } finally {
    isUpdating = false;
  }
}

// ============================================================================
// PHẦN 7: ĐỊNH TUYẾN (API ROUTES) VÀ BẢO MẬT
// ============================================================================

app.get("/api/stream", (req, res) => {
  if (clients.size >= 100) {
    return res.status(503).json({ error: "Server đang quá tải kết nối." });
  }

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
  req.on("error", () => { clients.delete(res); }); 
});

// FIX LỖI 1: Gắn syncLimiter chuẩn chỉ (đã xóa lastForceSync)
app.post("/api/force-sync", syncLimiter, async (req, res) => {
  try {
    // Ép server cào API ngay lập tức
    await updateData("Ép cào từ giao diện", true);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: "Lỗi đồng bộ" });
  }
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
    res.status(500).json({ error: "Lỗi tải lịch sử" });
  }
});

// Gắn limiter và delay vào endpoint delete
app.post("/api/history/bulk-delete", deleteLimiter, async (req, res) => {
  try {
    const { ids, secret } = req.body;
    const adminPass = process.env.ADMIN_PASS;

    // Tarpitting
    await new Promise(resolve => setTimeout(resolve, 1000));

    if (secret !== adminPass) {
      return res.status(403).json({ error: "Sai mật khẩu Admin!" }); 
    }

    if (!Array.isArray(ids) || ids.length === 0 || !ids.every(id => typeof id === 'string')) {
      return res.status(400).json({ error: "Dữ liệu không hợp lệ (Invalid Payload)" });
    }

    await History.deleteMany({ _id: { $in: ids } });
    cachedHistory = cachedHistory.filter(item => !ids.includes(item._id.toString()));

    if (cachedHistory.length > 0) {
      const last = cachedHistory[0];
      cachedLastSavedXau = last.xau;
      
      let diffRecord = cachedHistory.find(r => r.sjc !== latestData?.sjc);
      if (diffRecord) {
        lastDifferentSjc = { sjc: diffRecord.sjc, diff: diffRecord.diff };
      } else if (latestData) {
        lastDifferentSjc = { sjc: latestData.sjc, diff: latestData.diff };
      }

      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      yesterday.setHours(23, 59, 59, 999);
      let lastDayRecord = cachedHistory.find(r => new Date(r.createdAt) <= yesterday);
      cachedYesterdaySjc = lastDayRecord ? lastDayRecord.sjc : (latestData ? latestData.sjc : null);
    } else {
       cachedLastSavedXau = latestData ? latestData.xau : 2350;
       lastDifferentSjc = latestData ? { sjc: latestData.sjc, diff: latestData.diff } : null;
       cachedYesterdaySjc = latestData ? latestData.sjc : null;
    }

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: "Lỗi xóa" });
  }
});

// ============================================================================
// PHẦN 8: CRONJOB HỆ THỐNG
// ============================================================================
cron.schedule("*/5 * * * *", () => {
  if (isVietnamTradingTime() || isForexMarketOpen()) {
    updateData("Cronjob 5 phút");
  }
});