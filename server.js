const express = require("express");
const path = require("path"); 
const cron = require("node-cron");
const cors = require("cors");
const mongoose = require("mongoose");
const cheerio = require("cheerio");
const compression = require("compression"); // Nén dữ liệu để web tải nhanh hơn
const app = express();

// Cấu hình Express
app.set('trust proxy', 1);
app.use(compression({ level: 6, threshold: 1024 }));
app.use(cors()); // Mở CORS (tạm thời để web có thể gọi API)
app.use(express.json({ limit: "10kb" })); // Chống quá tải: Chỉ nhận dữ liệu JSON nhỏ hơn 10kb

// Phục vụ các file tĩnh (HTML, CSS, JS) trong thư mục public
app.use(express.static(path.join(__dirname, "public"), {
  maxAge: "1d",
  etag: true
}));

const PORT = process.env.PORT || 3000;

// Các biến lưu trữ dữ liệu trên RAM (Tối ưu tốc độ, hạn chế gọi DB)
let latestData = null;
let clients = new Set(); // Chứa các client đang kết nối SSE (Live stream)
let isUpdating = false; 

let lastDifferentSjc = null; 
let cachedLastSavedXau = null; 
let cachedYesterdaySjc = null;
let cachedYesterdayDate = null;
let cachedHistory = []; // Mảng chứa lịch sử giá trên RAM

// Hàm format thời gian theo múi giờ Việt Nam
function formatTimeVN(dateObj) {
  if (!dateObj) return "--";
  const pad = n => String(n).padStart(2, '0');
  const vn = new Date(new Date(dateObj).toLocaleString('en-US', { timeZone: 'Asia/Ho_Chi_Minh' }));
  return `${pad(vn.getDate())}/${pad(vn.getMonth()+1)} ${pad(vn.getHours())}:${pad(vn.getMinutes())}`;
}

// ─── TELEGRAM ALERT (Thông báo lỗi qua Telegram) ──────────────────────────
const TG_TOKEN   = process.env.TG_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const ALERT_COOLDOWN_MS = 10 * 60 * 1000; // 10 phút — chống spam báo cùng 1 lỗi liên tục
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

// Cấu trúc Database MongoDB
const HistorySchema = new mongoose.Schema({
  usd: Number, xau: Number, sjc: Number, worldVND: Number, diff: Number, percent: String, status: String
}, { timestamps: true });

// Đánh index để truy vấn nhanh hơn
HistorySchema.index({ createdAt: -1, sjc: 1 });
const History = mongoose.model("History", HistorySchema);

// Hàm nạp dữ liệu từ DB lên RAM khi vừa khởi động Server
async function preloadCache() {
  try {
    // Kéo 1000 dòng lịch sử mới nhất
    const historyData = await History.find()
      .select("createdAt xau sjc diff percent _id") 
      .sort({ createdAt: -1 })
      .limit(1000)
      .lean();
      
    if (historyData.length > 0) {
      for (const item of historyData) {
        item.timeStr = formatTimeVN(item.createdAt);
        // Định dạng ngày để dùng cho chức năng Lọc (Filter)
        item.filterDateStr = new Date(item.createdAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
      }
      cachedHistory = historyData;

      // --- TỐI ƯU: Lấy trực tiếp từ RAM thay vì gọi DB lần nữa ---
      const last = historyData[0]; // Dòng mới nhất
      cachedLastSavedXau = last.xau;
      latestData = { sjc: last.sjc, xau: last.xau, usd: last.usd }; 

      // Tìm dòng có giá SJC khác với giá hiện tại ngay trong mảng RAM
      let diffRecord = historyData.find(r => r.sjc !== last.sjc);
      
      // Chốt an toàn: Nếu trong mảng không có (do giá đứng im quá lâu), mới phải gọi DB
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

// Kết nối MongoDB
mongoose.connect(process.env.MONGO_URI, { 
  serverSelectionTimeoutMS: 5000, 
  maxPoolSize: 10, 
  minPoolSize: 2,
  heartbeatFrequencyMS: 10000 
})
  .then(async () => { 
    console.log("✅ MongoDB connected");
    await preloadCache(); // Nạp cache
    
    const server = app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      sendTelegram("🚀 Bot Telegram đã kết nối!", "server_start");
      updateData("Khởi động Server"); // Cập nhật ngay số liệu đầu tiên
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

// Giữ kết nối SSE (Live stream) không bị timeout bằng cách gửi ping mỗi 40s
setInterval(() => {
  for (const c of [...clients]) {
    try { c.write(":\n\n"); if (typeof c.flush === "function") c.flush(); } 
    catch (e) { clients.delete(c); }
  }
}, 40000); 

let cachedUsdRate = null; 
let lastUsdFetchTime = 0;
const USD_CACHE_DURATION = 60 * 60 * 1000; // Cache USD trong 1 tiếng

// Kiểm tra xem có đang trong giờ giao dịch vàng VN không
function isVietnamTradingTime() {
  const now = new Date();
  const vnTimeStr = now.toLocaleString("en-US", { timeZone: "Asia/Ho_Chi_Minh" });
  const vnTime = new Date(vnTimeStr);
  const day = vnTime.getDay(); 
  const hour = vnTime.getHours();
  const min = vnTime.getMinutes();
  const timeInMinutes = hour * 60 + min;

  if (day === 0) return false; // Chủ nhật đóng
  if (day >= 1 && day <= 5) return timeInMinutes >= 510 && timeInMinutes <= 1050; // T2-T6: 8h30 - 17h30
  if (day === 6) return timeInMinutes >= 510 && timeInMinutes <= 630; // Thứ 7: 8h30 - 10h30
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

// Hàm gọi API có cơ chế thử lại (Retry) nếu thất bại
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
      await new Promise(r => setTimeout(r, 300 * (i + 1))); // Tạm nghỉ trước khi thử lại
    }
  }
}

// Cào tỷ giá USD từ Vietcombank (XML)
async function getUsdRate() {
  const now = Date.now();
  // Nếu chưa hết 1 tiếng thì dùng lại giá cũ cho đỡ tốn tài nguyên
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

// Hàm hỗ trợ bóc tách giá vàng từ XML
async function getPriceFromXml(url, selector, attrName) {
  try {
    const xml = await fetchWithRetry(url, false);
    if (!xml) return 0;
    const $ = cheerio.load(xml, { xmlMode: true });
    const sellStr = $(selector).attr(attrName);
    if (sellStr) {
      let price = parseFloat(sellStr.replace(/,/g, ""));
      if (price > 0 && price < 1000000) price *= 1000; // Đồng bộ đơn vị tính (thành tiền VNĐ)
      return price;
    }
  } catch (err) {
    console.warn(`⚠️ [${new Date().toISOString()}] Parse lỗi từ ${url}: ${err.message}`);
  }
  return 0;
}

// Lấy giá SJC
async function getSjcPrice() {
  // Ưu tiên cào từ DOJI, fallback (dự phòng) sang Bảo Tín Minh Châu (BTMC)
  let price = await getPriceFromXml("https://giavang.doji.vn/api/giavang/?api_key=258fbd2a72ce8481089d88c678e9fe4f", 'Row[Key="dojihanoile"]', 'Sell');
  if (price > 0) return price;

  price = await getPriceFromXml("http://api.btmc.vn/api/BTMCAPI/getpricebtmc?key=3kd8ub1llcg9t45hnoh8hmn7t5kc2v", 'Data[row="932"]', 'ps_932');
  if (price > 0) return price;

  console.error(`❌ [${new Date().toISOString()}] getSjcPrice: Cả 2 nguồn DOJI và BTMC đều thất bại`);
  return 0; 
}

// ─── HÀM CỐT LÕI: Cập nhật toàn bộ dữ liệu ──────────────────────────────
async function updateData(triggerSource = "Tự động") {
  if (isUpdating) return; // Chống chạy đè nếu tác vụ trước chưa xong
  isUpdating = true;
  try {
    const isTrading = isVietnamTradingTime();
    const isForex = isForexMarketOpen();
    
    // Gọi song song 3 API để tiết kiệm thời gian (chỉ gọi nếu thị trường mở cửa)
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

    // Alert Telegram khi từng nguồn API bị fail (Để bạn biết đường mà sửa source)
    if (isForex && !isXauLive) sendTelegram(`⚠️ *API giá vàng thế giới (XAU) thất bại*\nKhông lấy được giá từ gold-api.com`, 'api_xau');
    if (isForex && !isUsdLive) sendTelegram(`⚠️ *API tỷ giá USD thất bại*\nKhông lấy được tỷ giá từ Vietcombank`, 'api_usd');
    if (isTrading && !isSjcLive) sendTelegram(`⚠️ *API giá SJC thất bại*\nCả DOJI lẫn BTMC đều không trả được giá`, 'api_sjc');

    // Nếu API sống thì lấy giá mới, nếu chết thì lấy giá cũ từ Database chắp vá vào
    let sjc = isSjcLive ? sjcPrice : (lastRecord ? lastRecord.sjc : 0);
    let xau = isXauLive ? dataXAU.price : (lastRecord ? lastRecord.xau : 2350);
    let usd = isUsdLive ? usdRate : (lastRecord ? lastRecord.usd : 25400); 

    // Nếu không có cả giá cũ lẫn giá mới thì báo lỗi hệ thống
    if (sjc <= 0 || xau <= 0) {
        if (latestData) {
          latestData.status = "Delayed (Lỗi hệ thống)";
          latestData.failedAPIs = ["SYSTEM"]; 
          const fallbackPayload = `data: ${JSON.stringify(latestData)}\n\n`;
          for (const c of [...clients]) { try { c.write(fallbackPayload); if (typeof c.flush === "function") c.flush(); } catch (err) { clients.delete(c); } }
        }
        return; 
    }

    // Công thức tính giá vàng thế giới quy đổi ra VNĐ (Đã bao gồm thuế phí cơ bản)
    const worldVND = xau * usd * (37.5 / 31.1035);
    const diff = sjc - worldVND; // Tính chênh lệch
    const currentGap = Math.round(diff);

    const todayStr = new Date().toDateString();
    // Tính toán biến động giá so với hôm qua
    if (cachedYesterdayDate !== todayStr || cachedYesterdaySjc === null) {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      yesterday.setHours(23, 59, 59, 999);
      
      // Tối ưu: Thử tìm trong RAM trước, không thấy mới lục DB
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
    if (isForex && !isUsdLive) failedAPIs.push("USD");
    if (isForex && !isXauLive) failedAPIs.push("XAU");

    let currentStatus = failedAPIs.length === 0 ? "Live" : `Delayed (Lỗi: ${failedAPIs.join(", ")})`;

    const updatedTimeObj = new Date();

    // Đóng gói dữ liệu để gửi cho Client
    latestData = {
      updatedAt: updatedTimeObj, timeStr: formatTimeVN(updatedTimeObj), 
      usd, xau, xauChange, sjc, sjcChange, oldGap: lastDifferentSjc.diff,       
      gapChange, worldVND: Math.round(worldVND), diff: currentGap,
      percent: ((diff / worldVND) * 100).toFixed(2) + "%", status: currentStatus,
      failedAPIs: failedAPIs
    };

    // CHỈ LƯU VÀO DATABASE KHI GIÁ SJC CÓ SỰ THAY ĐỔI
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
      
      // Thêm bản ghi mới vào đầu mảng RAM
      cachedHistory.unshift(slimDoc);
      
      // FIX LỖI TRÀN RAM: Luôn giữ mảng ở kích thước tối đa 1000 phần tử
      if (cachedHistory.length > 1000) {
        cachedHistory.length = 1000;
      }
    }

    if (process.env.NODE_ENV !== 'production') {
      console.log(`✅ [${currentStatus}] XAU: ${xau} | SJC: ${sjc} | GAP: ${currentGap}`);
    }

    // Bắn dữ liệu Live về cho toàn bộ các trình duyệt đang mở web
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

// ─── ĐỊNH TUYẾN (API ROUTES) ──────────────────────────────────────────────

// API: Stream dữ liệu realtime (Server-Sent Events)
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
  
  req.on("close", () => { clients.delete(res); }); // Gỡ client khi họ tắt tab
});

// API: Lấy dữ liệu hiện tại ngay lập tức (dùng khi mới load trang)
app.get("/api/gold", async (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=1');
    res.json(latestData || {});
});

// API: Lấy bảng lịch sử
app.get("/api/history", async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 1000);
  // Nếu có trong RAM thì nhả ra luôn cho nhanh
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

// API: Xóa nhiều bản ghi (ĐÃ BẢO MẬT BẰNG MẬT KHẨU)
app.post("/api/history/bulk-delete", async (req, res) => {
  try {
    const { ids, secret } = req.body;
    
    // Đọc mật khẩu từ cấu hình (Railway). Nếu quên cấu hình thì dùng pass cứng "admin123"
    const adminPass = process.env.ADMIN_PASS || "admin123";
    
    if (secret !== adminPass) {
      return res.status(403).json({ error: "Sai mật khẩu Admin!" }); // Từ chối nếu sai pass
    }

    if (!ids || !Array.isArray(ids)) return res.status(400).json({ error: "Thiếu danh sách ID" });
    
    await History.deleteMany({ _id: { $in: ids } });
    
    // Lọc bỏ các dòng đã xóa khỏi mảng RAM để giao diện load lại chuẩn xác
    cachedHistory = cachedHistory.filter(item => !ids.includes(item._id.toString()));
    
    res.json({ ok: true });
  } catch (error) { 
    res.status(500).json({ error: "Lỗi xóa" }); 
  }
});

// API: Nhận thông báo lỗi từ phía người dùng (Client)
app.post("/api/alert", async (req, res) => {
  try {
    const { message, key } = req.body;
    if (!message || typeof message !== 'string') return res.status(400).json({ error: "Thiếu message" });
    const safeKey = (typeof key === 'string' && key) ? key : 'client_alert';
    await sendTelegram(`📱 *Client Error*\n${message.slice(0, 500)}`, safeKey);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "Lỗi gửi alert" }); }
});

// ─── CRONJOB: Tự động chạy ngầm theo lịch ────────────────────────────────
cron.schedule("* * * * *", () => {
  const isTrading = isVietnamTradingTime();
  const currentMinute = new Date().getMinutes();
  
  if (isTrading) {
    updateData("Cronjob 1 phút"); // Đang giờ giao dịch VN thì cập nhật liên tục mỗi phút
  } else if (currentMinute % 5 === 0) {
    updateData("Cronjob 5 phút"); // Nghỉ giao dịch thì 5 phút mới ngó 1 lần cho đỡ tốn băng thông
  }
});