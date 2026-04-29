const express = require("express");
const cron = require("node-cron");
const cors = require("cors");
const mongoose = require("mongoose");
const cheerio = require("cheerio");
const compression = require("compression");
const https = require("https");
const agent = new https.Agent({ keepAlive: true });
const app = express();
app.use(compression());
app.use(cors());
app.use(express.json());
const path = require("path");
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

/* ===== CONNECT MONGO ===== */
// Tối ưu: Đưa logic khởi chạy vào bên trong .then để đảm bảo DB luôn sẵn sàng
mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 5000 })
  .then(() => {
    console.log("✅ MongoDB connected");
    // Khởi động server và chạy cào dữ liệu ngay sau khi DB sẵn sàng
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      updateData("Khởi động Server");
    });
  })
  .catch(err => { 
    console.error("❌ MongoDB error:", err); 
    process.exit(1); 
  });

/* ===== SCHEMA ===== */
const HistorySchema = new mongoose.Schema({
  usd: Number, xau: Number, sjc: Number, worldVND: Number,
  diff: Number, percent: String, status: String
}, { timestamps: true });

HistorySchema.index({ createdAt: -1 });
const History = mongoose.model("History", HistorySchema);

// Biến RAM Cache tổng
let latestData = null;
let clients = []; 
let isUpdating = false; 

// 🔥 HEARTBEAT giữ kết nối SSE không bị chết
setInterval(() => {
  clients.forEach(c => {
    c.write(":\n\n"); // ping nhẹ, client sẽ ignore
    if (typeof c.flush === "function") c.flush();
  });
}, 20000); // mỗi 20 giây

// Biến RAM Cache riêng cho USD (1 tiếng)
let cachedUsdRate = 1000;
let lastUsdFetchTime = 0;
const USD_CACHE_DURATION = 60 * 60 * 1000; // 1 tiếng tính bằng mili-giây

/* ===== FETCH HELPERS ===== */
async function fetchWithRetry(url, isJson = false) {
  try {
    const res = await fetch(url, {
      // Lưu ý: Nếu dùng Node 18+ native fetch, agent này sẽ bị ignore.
      // Nếu dùng node-fetch package thì nó sẽ hoạt động.
      agent: agent, 
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      signal: AbortSignal.timeout(8000) 
    });
    if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);
    return isJson ? await res.json() : await res.text();
  } catch (e) {
      console.warn(`⚠️ Cảnh báo: Lỗi khi lấy dữ liệu từ ${url} - ${e.message}`);
      return null; 
  }
}

/* ===== HÀM CÀO USD ĐỘC LẬP (CÓ CACHE 1 TIẾNG) ===== */
async function getUsdRate() {
  const now = Date.now();
  // Nếu chưa qua 1 tiếng và đã có dữ liệu trước đó -> Trả về dữ liệu cũ luôn, không cần cào mạng
  if (now - lastUsdFetchTime < USD_CACHE_DURATION && cachedUsdRate !== 1000) {
    return cachedUsdRate;
  }

  // Đã qua 1 tiếng -> Cào XML từ VCB
  const xml = await fetchWithRetry("https://portal.vietcombank.com.vn/Usercontrols/TVPortal.TyGia/pXML.aspx");
  if (xml) {
    // Bật chế độ xmlMode để cheerio đọc chính xác thẻ <Exrate>
    const $ = cheerio.load(xml, { xmlMode: true });
    // Lấy giá trị của thuộc tính Sell trong thẻ Exrate có CurrencyCode là USD
    const sellStr = $('Exrate[CurrencyCode="USD"]').attr('Sell');
    
    if (sellStr) {
      // Dữ liệu mẫu: "26,368.00" -> Xóa dấu phẩy và chuyển thành số nguyên/thập phân
      const parsedRate = parseFloat(sellStr.replace(/,/g, ""));
      if (!isNaN(parsedRate)) {
        cachedUsdRate = parsedRate;
        lastUsdFetchTime = now;
        console.log(`   💵 Đã cập nhật tỷ giá USD mới từ VCB XML: ${cachedUsdRate}`);
        return cachedUsdRate;
      }
    }
  }
  // Nếu lỗi mạng, trả về giá trị cache gần nhất
  return cachedUsdRate; 
}

/* ===== HÀM LẤY GIÁ SJC (CHÍNH: DOJI, FALLBACK: BTMC) ===== */
async function getSjcPrice() {
  // 1. THỬ LẤY TỪ DOJI TRƯỚC
  try {
    const dojiXml = await fetchWithRetry("https://giavang.doji.vn/api/giavang/?api_key=258fbd2a72ce8481089d88c678e9fe4f", false);
    if (dojiXml) {
      const $ = cheerio.load(dojiXml, { xmlMode: true });
      const sellStr = $('Row[Key="dojihanoile"]').attr('Sell');
      
      if (sellStr) {
        let price = parseFloat(sellStr.replace(/,/g, ""));
        // API thường trả về dạng nghìn đồng (vd: 89500), cần nhân 1000 để ra giá trị thực tế (89.500.000)
        if (price > 0 && price < 1000000) price *= 1000; 
        console.log(`   🌟 Đã lấy giá SJC từ DOJI: ${price.toLocaleString('vi-VN')}`);
        return price;
      }
    }
  } catch (err) {
    console.warn("   ⚠️ DOJI gặp sự cố, đang chuyển sang API dự phòng BTMC...");
  }

  // 2. NẾU DOJI LỖI -> DÙNG FALLBACK BTMC
  try {
    const btmcXml = await fetchWithRetry("http://api.btmc.vn/api/BTMCAPI/getpricebtmc?key=3kd8ub1llcg9t45hnoh8hmn7t5kc2v", false);
    if (btmcXml) {
      const $ = cheerio.load(btmcXml, { xmlMode: true });
      const sellStr = $('Data[row="932"]').attr('ps_932');
      
      if (sellStr) {
        let price = parseFloat(sellStr.replace(/,/g, ""));
        // BTMC cũng thường trả về dạng nghìn đồng
        if (price > 0 && price < 1000000) price *= 1000; 
        console.log(`   🌟 Đã lấy giá SJC từ BTMC (Dự phòng): ${price.toLocaleString('vi-VN')}`);
        return price;
      }
    }
  } catch (err) {
    console.warn("   ⚠️ BTMC cũng gặp sự cố!");
  }

  return 0; // Trả về 0 nếu cả 2 API đều sập
}

/* ===== UPDATE LOGIC (CÀO DỮ LIỆU CHÍNH) ===== */
async function updateData(triggerSource = "Tự động") {
  if (isUpdating) return; 
  isUpdating = true;
  try {
    console.log(`\n▶ [${triggerSource}] Bắt đầu cào dữ liệu lúc ${new Date().toLocaleTimeString('vi-VN')}`);
    
    // Gọi song song 3 hàm lấy dữ liệu
    const [usdRate, dataXAU, sjcPrice] = await Promise.all([
      getUsdRate(), // Hàm này sẽ cực kỳ nhanh nếu đang trong thời gian 1 tiếng cache
      fetchWithRetry("https://api.gold-api.com/price/XAU", true),
      getSjcPrice() // Thay thế cào HTML SJC bằng hàm lấy API mới
    ]);

    let lastRecord = latestData; 
    if (!lastRecord) {
      // Tối ưu: Thêm catch lỗi DB ở đây để tránh crash cả hàm cào
      lastRecord = await History.findOne().sort({ createdAt: -1 }).lean().catch(() => null);
    }
    
        
    // --- Kiểm tra tính sẵn sàng của dữ liệu (MỚI) ---
    const isSjcLive = sjcPrice > 0;
    const isXauLive = !!(dataXAU && dataXAU.price);

    // SỬA TẠI ĐÂY: Luôn lấy bản ghi thực tế cuối cùng từ Database để so sánh Gap
    const dbLastRecord = await History.findOne().sort({ createdAt: -1 }).lean().catch(() => null);
    // --- Xử lý FALLBACK (Nếu hỏng thì dùng lastRecord) ---
    let sjc = isSjcLive ? sjcPrice : (lastRecord ? lastRecord.sjc : 0);
    let xau = isXauLive ? dataXAU.price : (lastRecord ? lastRecord.xau : 2350);
    let usd = usdRate;

    // --- FALLBACK tỷ giá USD ---
    if (usd === 1000 && lastRecord) usd = lastRecord.usd;

    if (sjc <= 0 || xau <= 0) {
        console.log("❌ LỖI NGHIÊM TRỌNG: Không thể cào dữ liệu từ cả 3 nguồn và cũng không có bản lưu dự phòng!");
        console.log(`   👉 Chi tiết lỗi cào: SJC=${sjc}, XAU=${xau}, USD=${usd}`);
        return; 
    }

    // --- TÍNH TOÁN ---
        const diff = sjc - worldVND;

    // --- TÍNH TOÁN GAP HIỆN TẠI ---
    const worldVND = xau * usd * (37.5 / 31.1035);
    const currentDiff = Math.round(sjc - worldVND);

    // --- TÍNH GAP CHANGE: CŨ TRỪ MỚI (CHỈ KHAI BÁO 1 LẦN) ---
    // Logic: Gap trong DB (Cũ) - Gap vừa tính (Mới)
    const gapChange = dbLastRecord ? (dbLastRecord.diff - currentDiff) : 0;
    
    // --- MỚI: Tìm giá đóng cửa ngày hôm trước để tính Change ---
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(23, 59, 59, 999);

    // Tìm bản ghi cuối cùng của ngày hôm qua hoặc cũ hơn
    const lastDayRecord = await History.findOne({
      createdAt: { $lte: yesterday }
    }).sort({ createdAt: -1 }).lean().catch(() => null);

    // Nếu không có giá hôm qua (mới chạy app), dùng chính giá hiện tại làm mốc
    const referenceSJC = lastDayRecord ? lastDayRecord.sjc : sjc;
    const sjcChange = sjc - referenceSJC;
   

   // --- LƯU VÀO RAM CACHE ---
    latestData = {
      updatedAt: new Date(), 
      usd, 
      xau, 
      sjc,
      sjcChange: sjcChange, 
      gapChange: gapChange,
      worldVND: Math.round(worldVND), 
      diff: Math.round(diff),
      percent: ((diff / worldVND) * 100).toFixed(2) + "%",
      // Chỉ báo Live nếu CẢ HAI nguồn SJC và Thế giới đều lấy được giá mới nhất
      status: (isSjcLive && isXauLive) ? "Live" : "Delayed" 
    };

    // --- IN BẢNG LOG KẾT QUẢ CÀO (DÀNH CHO DEPLOY) ---
    console.log("----------------------------------------");
    console.log("📊 KẾT QUẢ CÀO DỮ LIỆU:");
    console.log(`   💵 USD: ${latestData.usd.toLocaleString('vi-VN')} VNĐ`);
    console.log(`   🌍 XAU: ${latestData.xau.toLocaleString('en-US')} USD/oz`);
    console.log(`   🧈 SJC: ${latestData.sjc.toLocaleString('vi-VN')} VNĐ`);
    console.log(`   ⚖️ GAP: ${latestData.diff.toLocaleString('vi-VN')} VNĐ (${latestData.percent})`);
    console.log("----------------------------------------");

    // --- LƯU DATABASE ---
    if (sjc > 0 && (!lastRecord || lastRecord.sjc !== sjc)) {
      const dbEntry = { ...latestData };
      delete dbEntry.updatedAt; 
      await History.create(dbEntry);
      console.log(`   💾 DB: Đã lưu bản ghi SJC mới là ${sjc.toLocaleString('vi-VN')}`);
      
      const count = await History.countDocuments();
      // Tối ưu xóa nhiều bản ghi một lúc nếu vượt quá 200 (Tránh tích tụ rác)
      if (count > 200) {
        const excess = count - 200;
        const idsToDelete = await History.find().sort({ createdAt: 1 }).limit(excess).select("_id").lean();
        await History.deleteMany({ _id: { $in: idsToDelete.map(d => d._id) } });
      }
    } else {
      console.log(`   ⏩ DB: Giá SJC không đổi (${sjc.toLocaleString('vi-VN')}), không lưu rác.`);
    }

    // --- ĐẨY DỮ LIỆU SSE CHO CLIENT ---
    clients.forEach(c => {
      c.write(`data: ${JSON.stringify(latestData)}\n\n`);
      if (typeof c.flush === "function") c.flush();
    });
    console.log(`   ✅ Đã đẩy Realtime xuống ${clients.length} client(s) đang kết nối.`);

  } catch (e) {
    console.log("❌ LỖI HỆ THỐNG (TRY-CATCH) TRONG UPDATE-DATA:", e.message);
  } finally {
    isUpdating = false;
  }
}

/* ===== API & SSE ===== */

app.get("/api/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  
  clients.push(res);
  
  if (latestData) {
      res.write(`data: ${JSON.stringify(latestData)}\n\n`);
      if (typeof res.flush === "function") res.flush();
  }

  req.on("close", () => clients = clients.filter(c => c !== res));
});

app.get("/api/gold", async (req, res) => {
    res.json(latestData || {});
});

app.get("/api/history", async (req, res) => {
  const data = await History.find().sort({ createdAt: -1 }).limit(100).lean();
  res.json(data);
});

app.post("/api/history/bulk-delete", async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids)) return res.status(400).json({ error: "Thiếu danh sách ID" });
    await History.deleteMany({ _id: { $in: ids } });
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ error: "Lỗi xóa" }); }
});

/* ===== CRONJOB (QUẢN LÝ LỊCH TRÌNH) ===== */
cron.schedule("*/5 * * * *", () => updateData("Cronjob 5 phút"));

// Xóa lệnh listen ở cuối cùng vì đã đưa lên phía trên phần kết nối DB thành công
