// ============================================================================
// PHẦN 1: KHỞI TẠO THƯ VIỆN & CẤU HÌNH SERVER
// ============================================================================
const express = require("express");
const path = require("path");
const cron = require("node-cron");
const mongoose = require("mongoose");
const cheerio = require("cheerio");
const compression = require("compression");
const app = express();

app.set('trust proxy', 1);
// Nén Gzip để truyền tải JSON nhẹ hơn
app.use(compression({ level: 6, threshold: 1024 }));
// Giới hạn Payload phòng chống DDOS/Bom payload
app.use(express.json({ limit: "10kb" })); 

// Phục vụ các file tĩnh (Frontend)
app.use(express.static(path.join(__dirname, "public"), {
  maxAge: "1d",
  etag: true
}));

const PORT = process.env.PORT || 3000;

// ============================================================================
// PHẦN 2: HỆ THỐNG CACHE IN-MEMORY (LƯU TRÊN RAM)
// ============================================================================
let latestData = null;      // Lưu snapshot giá vàng gần nhất
let clients = new Set();    // Tập hợp chứa các User đang kết nối SSE
let isUpdating = false;     // Khóa lock chống chạy đè cronjob
let lastForceSync = 0;      // Chống bấm nút đồng bộ liên tục
let lastDifferentSjc = null;// Cache khoảng chênh lệch khi SJC có thay đổi
let cachedLastSavedXau = null; 
let cachedYesterdaySjc = null;
let cachedYesterdayDate = null;
let cachedHistory = [];     // Bộ đệm mảng lịch sử tránh chọc DB liên tục

// Hàm phụ trợ fomat thời gian theo Việt Nam
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
const ALERT_COOLDOWN_MS = 10 * 60 * 1000; // Cooldown 10 phút chống spam tin nhắn
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

// Hàm kéo toàn bộ DB lên RAM lúc khởi động server
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
        updatedAt: new Date(), timeStr: formatTimeVN(new Date())
      };

      let diffRecord = historyData.find(r => r.sjc !== last.sjc);
      if (!diffRecord) {
        diffRecord = await History.findOne({ sjc: { $ne: last.sjc } }).select('sjc diff').sort({ createdAt: -1 }).lean();
      }

      lastDifferentSjc = diffRecord ? { sjc: diffRecord.sjc, diff: diffRecord.diff } : { sjc: last.sjc, diff: last.diff };
      console.log(`📦 Đã nạp (Preload) toàn bộ ${historyData.length} dòng History lên RAM.`);
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
    // Giữ kết nối HTTP sống lâu để phục vụ SSE không bị timeout
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

// Giữ nhịp đập (Heartbeat) cho mảng SSE Client không bị trình duyệt ngắt
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
// PHẦN 5: XỬ LÝ NGUỒN CÀO DATA (SCRAPING LÒNG GHÉP RETRY)
// ============================================================================
let cachedUsdRate = null;
let lastUsdFetchTime = 0;
const USD_CACHE_DURATION = 60 * 60 * 1000; // Cache USD 1 tiếng

// Kiểm tra giờ hành chính Việt Nam để hạn chế cào SJC/USD buổi đêm
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

// Kiểm tra phiên Forex mở cửa
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

// Gọi API có cơ chế Retry phòng hờ mạng nghẽn
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

// Cào Tỷ giá Vietcombank
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

// Hàm hỗ trợ bóc tách giá SJC từ File XML
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

// Cào giá SJC (Dùng cơ chế Backup: Nếu Doji sập thì đổi sang BTMC)
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

    // Chạy các lệnh Cào Data song song (Concurrency)
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

    // Bắn tin báo lỗi về Telegram nếu các nguồn API sập
    if (isForex && !isXauLive) sendTelegram(`⚠️ *API giá vàng thế giới (XAU) thất bại*\nKhông lấy được giá từ gold-api.com`, 'api_xau');
    if (isTrading && !isUsdLive) sendTelegram(`⚠️ *API tỷ giá USD thất bại*\nKhông lấy được tỷ giá từ Vietcombank`, 'api_usd');
    if (isTrading && !isSjcLive) sendTelegram(`⚠️ *API giá SJC thất bại*\nCả DOJI lẫn BTMC đều không trả được giá`, 'api_sjc');

    let sjc = isSjcLive ? sjcPrice : (lastRecord ? lastRecord.sjc : 0);
    let xau = isXauLive ? dataXAU.price : (lastRecord ? lastRecord.xau : 2350);
    let usd = isUsdLive ? usdRate : (lastRecord ? lastRecord.usd : 25400);

    // Fallback: Nếu không có cả giá cũ lẫn giá mới thì báo bảo trì
    if (sjc <= 0 || xau <= 0) {
      if (latestData) {
        latestData.status = "Delayed (Lỗi hệ thống)";
        latestData.failedAPIs = ["SYSTEM"];
        const fallbackPayload = `data: ${JSON.stringify(latestData)}\n\n`;
        for (const c of [...clients]) { try { c.write(fallbackPayload); if (typeof c.flush === "function") c.flush(); } catch (err) { clients.delete(c); } }
      }
      return;
    }

    // TÍNH TOÁN MARKET GAP
    const worldVND = xau * usd * (37.5 / 31.1035);
    const diff = sjc - worldVND; 
    const currentGap = Math.round(diff);

    // Trích xuất giá đóng cửa của ngày hôm qua để tính Delta (Tăng/giảm so với hqua)
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

    // Gói Payload JSON chuẩn bị trả về cho Client
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

    // BẮN DATA MỚI XUỐNG TẤT CẢ CLIENT QUA KÊNH SSE
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

// Kênh đường ống SSE (Client kết nối vào đây sẽ giữ máy chủ trả dữ liệu liên tục)
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

// Endpoint ép đồng bộ ngay lập tức từ giao diện người dùng
app.post("/api/force-sync", async (req, res) => {
  const now = Date.now();
  if (now - lastForceSync < 10000) {
    return res.status(429).json({ error: "Thao tác quá nhanh, vui lòng đợi!" });
  }
  lastForceSync = now;
  try {
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

// Endpoint lấy lịch sử (Ưu tiên lấy RAM Cache thay vì chọc thẳng MongoDB)
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

// Xóa mảng lịch sử (Đã vá lỗi tính toán lại Cache RAM)
app.post("/api/history/bulk-delete", async (req, res) => {
  try {
    const { ids, secret } = req.body;
    const adminPass = process.env.ADMIN_PASS;

    if (secret !== adminPass) {
      return res.status(403).json({ error: "Sai mật khẩu Admin!" }); 
    }

    if (!Array.isArray(ids) || ids.length === 0 || !ids.every(id => typeof id === 'string')) {
      return res.status(400).json({ error: "Dữ liệu không hợp lệ (Invalid Payload)" });
    }

    await History.deleteMany({ _id: { $in: ids } });
    cachedHistory = cachedHistory.filter(item => !ids.includes(item._id.toString()));

    // VÁ LỖI: Tính toán lại các biến phụ thuộc sau khi xóa
    if (cachedHistory.length > 0) {
      const last = cachedHistory[0];
      cachedLastSavedXau = last.xau;
      
      // Tìm lại mốc SJC có chênh lệch gần nhất
      let diffRecord = cachedHistory.find(r => r.sjc !== latestData?.sjc);
      if (diffRecord) {
        lastDifferentSjc = { sjc: diffRecord.sjc, diff: diffRecord.diff };
      } else if (latestData) {
        lastDifferentSjc = { sjc: latestData.sjc, diff: latestData.diff };
      }

      // Tìm lại giá SJC chốt phiên hôm qua
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      yesterday.setHours(23, 59, 59, 999);
      let lastDayRecord = cachedHistory.find(r => new Date(r.createdAt) <= yesterday);
      cachedYesterdaySjc = lastDayRecord ? lastDayRecord.sjc : (latestData ? latestData.sjc : null);
    } else {
       // Reset nếu xóa sạch DB
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
// Cứ 5 phút tự động kích hoạt cào lấy số mới nếu đang trong giờ giao dịch
cron.schedule("*/5 * * * *", () => {
  if (isVietnamTradingTime() || isForexMarketOpen()) {
    updateData("Cronjob 5 phút");
  }
});