const API = "/api/gold";
const HIST_API = "/api/history"; 
const elements = {
  usd: document.getElementById("usd"), xau: document.getElementById("xau"),
  sjc: document.getElementById("sjc"), diff: document.getElementById("diff"),
  percent: document.getElementById("percent"), gapChange: document.getElementById("gapChange"), lastTime: document.getElementById("lastTime"),
  historyTable: document.getElementById("history"), filterBox: document.getElementById("filterBox"),
  startDate: document.getElementById("startDate"), endDate: document.getElementById("endDate"), toggleBtn: document.getElementById("toggleBtn"),
  actionHeader: document.getElementById("actionHeader"), pagination: document.getElementById("pagination")
};

const fmtVND = new Intl.NumberFormat('vi-VN');
const fmtXAU = new Intl.NumberFormat('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

let historyData = []; 
let currentData = []; 
let lastSJCValue = null; 
let myChart = null;
let lastChartSignature = "";
let isExpanded = false; 
let currentPage = 1;
// Thêm đoạn này vào để chống spam API
let historyTimeout;

function safeFetchHistory(isInit = false) {
  clearTimeout(historyTimeout);
  // Nếu là lần tải trang đầu tiên, bỏ qua bộ đếm thời gian
  if (isInit) {
    fetchHistory();
    return;
  }
  historyTimeout = setTimeout(() => {
    fetchHistory();
  }, 100);
}

const dateCache = new Map();
/* ===== NHẬN REALTIME DỮ LIỆU TỪ SERVER MÀ KHÔNG CẦN RELOAD ===== */
const evtSource = new EventSource("/api/stream");
evtSource.onmessage = (event) => {
  const d = JSON.parse(event.data);
  if (!d || Object.keys(d).length === 0) return;
  
  // Hiệu ứng nháy màu báo có data mới
  elements.lastTime.style.color = "#10b981";
  setTimeout(() => elements.lastTime.style.color = "#64748b", 2000);
  
  renderMain(d);
  if (lastSJCValue === null || d.sjc !== lastSJCValue) {
  const isFirstLoad = lastSJCValue === null;
  lastSJCValue = d.sjc;
  safeFetchHistory(isFirstLoad); // Truyền cờ isFirstLoad vào
}
};

/* ===== TẢI DỮ LIỆU (CÓ THỂ ÉP BUỘC SERVER CÀO LIỀN) ===== */
async function load() {
  try {
    // Chỉ gọi API với timestamp để chống trình duyệt lưu cache
    const res = await fetch(`${API}?t=${Date.now()}`);
    const d = await res.json();
    
    if (!d || Object.keys(d).length === 0) return;
    
    renderMain(d);
    
    // Logic cập nhật dữ liệu và gọi history
    if (lastSJCValue === null || d.sjc !== lastSJCValue) {
      const isFirstLoad = lastSJCValue === null;
      lastSJCValue = d.sjc;
      safeFetchHistory(isFirstLoad);
    }
  } catch(e) { 
    console.error(e); 
  }
}

function renderMain(d) {
  elements.usd.innerText = fmtVND.format(d.usd);
  elements.diff.innerText = fmtVND.format(d.diff);
  elements.percent.innerText = d.percent;

  // --- PHẦN MỚI: Cập nhật ô XAU (Có sub màu đen tuyền) ---
  const xChange = d.xauChange || 0;
  const isXUp = xChange >= 0;
  elements.xau.innerHTML = `
    <div>${fmtXAU.format(d.xau)}</div>
    <div class="sjc-sub" style="color: #000; font-weight: 700;">
      ${isXUp ? '▲' : '▼'} ${fmtXAU.format(Math.abs(xChange))}
    </div>
  `;

  // --- Cập nhật ô Gap Change ---
  if (elements.gapChange && d.gapChange !== undefined) {
    const gVal = d.gapChange;
    const gPrefix = gVal > 0 ? "+" : ""; // Hiện dấu + nếu số dương
    elements.gapChange.innerText = gPrefix + fmtVND.format(gVal);

    // Đổi màu dựa trên giá trị âm/dương
    if (gVal > 0) {
      elements.gapChange.style.color = "var(--up-color)";
    } else if (gVal < 0) {
      elements.gapChange.style.color = "var(--down-color)";
    } else {
      elements.gapChange.style.color = "var(--secondary-text)";
    }
  }

  // --- Cập nhật ô SJC (Giữ nguyên màu xanh/đỏ) ---
  const change = d.sjcChange || 0;
  const isUp = change >= 0;
  elements.sjc.innerHTML = `
    <div>${fmtVND.format(d.sjc)}</div>
    <div class="sjc-sub ${isUp ? 'change-up' : 'change-down'}">
      ${isUp ? '▲' : '▼'} ${fmtVND.format(Math.abs(change))}
    </div>
  `;

  const updateTime = new Date(d.updatedAt);
  const timeStr = isNaN(updateTime) ? new Date().toLocaleTimeString('vi-VN') : updateTime.toLocaleTimeString('vi-VN');
  
  // Thay đổi cách hiển thị status để in ra đúng chữ "Delayed (Lỗi: SJC)" từ Server gửi xuống
  elements.lastTime.innerHTML = `${d.status === "Live" ? "🟢 Live" : "🟡 " + d.status} - Cập nhật: ${timeStr}`;
}

async function fetchHistory() {
  try {
    const res = await fetch(HIST_API);
    historyData = await res.json(); 
    currentData = [...historyData]; 
    renderTable(); 
    updateChart(currentData);
  } catch(e) { console.error(e); }
}

function formatVNDateTime(isoString) {
  // 1. Kiểm tra xem ngày này đã có trong kho chứa (Cache) chưa
  if (dateCache.has(isoString)) {
    return dateCache.get(isoString); // Nếu có rồi thì lấy ra dùng luôn, không cần tính lại
  }

  // 2. Nếu chưa có, tiến hành tính toán định dạng như cũ
  const d = new Date(isoString);
  if (isNaN(d)) return "--";
  
  const formatted = d.toLocaleString('vi-VN', { 
    timeZone: 'Asia/Ho_Chi_Minh', 
    day: '2-digit', 
    month: '2-digit', 
    hour: '2-digit', 
    minute: '2-digit' 
  });

  // 3. Lưu kết quả vừa tính vào kho để lần sau không phải tính lại
  dateCache.set(isoString, formatted);

  return formatted;
}

function renderTable() {
  const pageSize = isExpanded ? 20 : 10;
  const startIdx = isExpanded ? (currentPage - 1) * pageSize : 0;
  const endIdx = startIdx + pageSize;
  const displayData = currentData.slice(startIdx, endIdx);
  const displayStyle = isExpanded ? "table-cell" : "none";
  document.getElementById('selectAll').checked = false;

  // TỐI ƯU HIỆU NĂNG: Sử dụng DOM ảo thay vì chuỗi Text HTML
  const fragment = document.createDocumentFragment();

  displayData.forEach(r => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${formatVNDateTime(r.createdAt)}</td>
      <td>${fmtXAU.format(r.xau)}</td>
      <td>${fmtVND.format(r.sjc)}</td>
      <td>${fmtVND.format(r.diff)}</td>
      <td><span class="badge ${r.percent.includes('-') ? 'badge-down' : 'badge-up'}">${r.percent}</span></td>
      <td class="col-action" style="display: ${displayStyle}; text-align: center;">
        <input type="checkbox" class="log-checkbox" value="${r._id}">
      </td>
    `;
    fragment.appendChild(tr);
  });

  // Làm sạch bảng và chèn DOM ảo vào 1 lần duy nhất (Rất mượt)
  elements.historyTable.innerHTML = "";
  elements.historyTable.appendChild(fragment);
  
  renderPagination();
}

function renderPagination() {
  const pag = elements.pagination;
  if (!isExpanded || currentData.length <= 20) { pag.style.display = "none"; return; }
  pag.style.display = "flex"; pag.innerHTML = "";
  const totalPages = Math.ceil(currentData.length / 20);
  const prevBtn = document.createElement("button");
  prevBtn.className = "page-btn"; prevBtn.innerText = "« Trước";
  prevBtn.disabled = currentPage === 1;
  prevBtn.onclick = () => { if (currentPage > 1) { currentPage--; renderTable(); } };
  pag.appendChild(prevBtn);
  let startPage = Math.max(1, currentPage - 2);
  let endPage = Math.min(totalPages, startPage + 4);
  if (endPage - startPage < 4) startPage = Math.max(1, endPage - 4);
  for (let i = startPage; i <= endPage; i++) {
    const btn = document.createElement("button");
    btn.className = `page-btn ${i === currentPage ? "active" : ""}`; btn.innerText = i;
    btn.onclick = () => { currentPage = i; renderTable(); };
    pag.appendChild(btn);
  }
  const nextBtn = document.createElement("button");
  nextBtn.className = "page-btn"; nextBtn.innerText = "Sau »";
  nextBtn.disabled = currentPage === totalPages;
  nextBtn.onclick = () => { if (currentPage < totalPages) { currentPage++; renderTable(); } };
  pag.appendChild(nextBtn);
}

function toggleFilterBox() {
  isExpanded = !isExpanded;
  elements.filterBox.style.display = isExpanded ? "flex" : "none";
  elements.toggleBtn.innerText = isExpanded ? "−" : "+";
  elements.actionHeader.style.display = isExpanded ? "table-cell" : "none";
  currentPage = 1;
  renderTable();
}

function applyFilter() {
  const startStr = elements.startDate.value;
  const endStr = elements.endDate.value;
  
  currentData = (!startStr && !endStr) ? [...historyData] : historyData.filter(r => {
    const d = new Date(r.createdAt);
    if(isNaN(d)) return false;
    const formatted = d.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }); 
    if(startStr && formatted < startStr) return false;
    if(endStr && formatted > endStr) return false;
    return true;
  });
  
  currentPage = 1; 
  renderTable(); 
  updateChart(currentData);
}
// Hàm Bỏ lọc (Xóa trắng ngày tháng và hiển thị lại toàn bộ dữ liệu)
function resetFilter() {
  elements.startDate.value = "";
  elements.endDate.value = "";
  currentData = [...historyData]; // Trả lại dữ liệu gốc
  currentPage = 1; 
  renderTable(); 
  updateChart(currentData);
}

function toggleSelectAll(source) {
  const checkboxes = document.querySelectorAll('.log-checkbox');
  checkboxes.forEach(cb => cb.checked = source.checked);
}

async function deleteSelected() {
  const checkedBoxes = document.querySelectorAll('.log-checkbox:checked');
  if (checkedBoxes.length === 0) { alert("Vui lòng tích chọn ít nhất 1 dòng để xóa."); return; }
  if (!confirm(`Bạn có chắc chắn muốn xóa ${checkedBoxes.length} bản ghi đã chọn?`)) return;
  const ids = Array.from(checkedBoxes).map(cb => cb.value);
  try {
    const res = await fetch('/api/history/bulk-delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: ids })
    });
    if (res.ok) await fetchHistory(); else alert("Lỗi khi xóa dữ liệu!");
  } catch(e) { console.error(e); alert("Lỗi mạng!"); }
}

function updateChart(data) {
    // 1. Kiểm tra an toàn nếu không có dữ liệu
  if (!data || data.length === 0) return;

  // 2. TẠO CHỮ KÝ DỮ LIỆU
  // data[0] là bản ghi mới nhất (vì mảng sort từ mới đến cũ)
  const currentSignature = `${data.length}_${data[0].createdAt}`;

  // 3. KIỂM TRA CHỮ KÝ
  if (currentSignature === lastChartSignature) {
    // Nếu chữ ký y hệt lần vẽ trước -> Dữ liệu không đổi -> Hủy vẽ!
    return; 
  }

  // 4. LƯU LẠI CHỮ KÝ MỚI ĐỂ DÀNH CHO LẦN SAU
  lastChartSignature = currentSignature;
  const chartCanvas = document.getElementById('gapChart');
  const ctx = chartCanvas.getContext('2d');
  const reversedData = [...data].reverse();
  const totalPoints = reversedData.length;

  const wrapper = chartCanvas.parentElement;
  const scrollContainer = document.querySelector('.chart-scroll-container');
  const containerWidth = scrollContainer.clientWidth || window.innerWidth;

  const maxSpacing = 110; 
  const minSpacing = 75;  
  const minPointsToFill = Math.ceil(containerWidth / maxSpacing);

  const labels = reversedData.map(r => {
    const d = new Date(r.createdAt);
    return d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
  });
  const gaps = reversedData.map(r => r.diff / 1000000);

  // --- TRỊ BỆNH KÉO GIÃN: CHÈN ĐIỂM ẢO ---
  if (totalPoints > 0 && totalPoints < minPointsToFill) {
    const padCount = minPointsToFill - totalPoints;
    for (let i = 0; i < padCount; i++) {
      labels.push(''); 
      gaps.push(null); 
    }
  }

  // --- THÊM LOGIC TRỊ BỆNH CHẠM ĐÁY/CHẠM NÓC TRỤC Y ---
  const validGaps = gaps.filter(g => g !== null);
  let yMin = 0;
  let yMax = 0;

  if (validGaps.length > 0) {
    const minVal = Math.min(...validGaps);
    const maxVal = Math.max(...validGaps);
    const range = maxVal - minVal;

    // Nới lề trên/dưới thêm 20%. Nếu dữ liệu đang đứng im (range = 0), tự nới biên độ 0.5M (500k)
    const padding = range === 0 ? 0.5 : range * 0.2; 
    
    yMin = minVal - padding;
    yMax = maxVal + padding;
  }

  const calculatedWidth = totalPoints * minSpacing;

  if (calculatedWidth > containerWidth) {
    wrapper.style.setProperty('width', calculatedWidth + 'px', 'important');
    wrapper.style.setProperty('min-width', calculatedWidth + 'px', 'important');
  } else {
    wrapper.style.setProperty('width', '100%', 'important');
    wrapper.style.setProperty('min-width', '100%', 'important');
  }

  if (myChart) {
    myChart.data.labels = labels;
    myChart.data.datasets[0].data = gaps;
    // Cập nhật lại trục Y linh hoạt khi có dữ liệu mới
    myChart.options.scales.y.suggestedMin = yMin;
    myChart.options.scales.y.suggestedMax = yMax;
    myChart.update('none');
  } else {
    myChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels,
        datasets: [{
          data: gaps,
          borderColor: '#3b82f6',
          backgroundColor: 'rgba(59, 130, 246, 0.1)',
          borderWidth: 2,
          fill: true,
          tension: 0.3,
          pointRadius: 3
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: {
            suggestedMin: yMin, // Điểm bắt đầu của vạch dưới cùng
            suggestedMax: yMax, // Điểm kết thúc của vạch trên cùng
            beginAtZero: false,
            ticks: {
              maxTicksLimit: 6,
              callback: (val) => val.toFixed(1) + 'M',
              color: '#64748b',
              font: { size: 11 }
            },
            grid: { color: 'rgba(226, 232, 240, 0.6)' }
          },
          x: {
            ticks: { autoSkip: false, color: '#64748b', font: { size: 10 } },
            grid: { display: false }
          }
        }
      }
    });
  }
  
  const container = document.querySelector('.chart-scroll-container');
  setTimeout(() => { container.scrollLeft = container.scrollWidth; }, 200);
}

/* KHỞI CHẠY LẦN ĐẦU (F5) SẼ YÊU CẦU SERVER ÉP CÀO LẠI (FORCE = TRUE) */
load();



/* ===== HIỆU ỨNG PULL TO REFRESH ===== */
const style = document.createElement('style');
style.innerHTML = `
  .cyber-pull-container {
    position: fixed; top: -80px; left: 50%; transform: translateX(-50%);
    display: flex; align-items: center; gap: 15px;
    background: rgba(15, 23, 42, 0.85); backdrop-filter: blur(10px);
    padding: 12px 24px; border-radius: 40px;
    border: 1px solid rgba(59, 130, 246, 0.3);
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
    z-index: 9999;
    transition: top 0.3s cubic-bezier(0.4, 0, 0.2, 1), border-color 0.3s, box-shadow 0.3s;
    pointer-events: none;
  }
  .cyber-pull-container.ready {
    border-color: rgba(16, 185, 129, 0.8); box-shadow: 0 0 25px rgba(16, 185, 129, 0.2);
  }
  .pulse-bars { display: flex; gap: 4px; align-items: flex-end; height: 24px; }
  .pulse-bar {
    width: 5px; height: 4px; border-radius: 2px;
    background: #3b82f6; transition: background 0.3s;
  }
  .cyber-pull-container.ready .pulse-bar { background: #10b981; }
  .cyber-pull-container.refreshing .pulse-bar {
    background: #10b981; animation: pulseWave 0.5s ease-in-out infinite alternate;
  }
  .cyber-pull-container.refreshing .pulse-bar:nth-child(1) { animation-delay: 0.0s; }
  .cyber-pull-container.refreshing .pulse-bar:nth-child(2) { animation-delay: 0.1s; }
  .cyber-pull-container.refreshing .pulse-bar:nth-child(3) { animation-delay: 0.2s; }
  .cyber-pull-container.refreshing .pulse-bar:nth-child(4) { animation-delay: 0.3s; }

  @keyframes pulseWave {
    0% { height: 4px; box-shadow: none; }
    100% { height: 24px; box-shadow: 0 0 10px #10b981; }
  }

  .cyber-text {
    color: #94a3b8; font-size: 14px; font-weight: 600; font-family: 'Inter', sans-serif;
    transition: color 0.3s;
  }
  .cyber-pull-container.ready .cyber-text { color: #10b981; text-shadow: 0 0 8px rgba(16,185,129,0.4); }
`;
document.head.appendChild(style);

const pullContainer = document.createElement("div");
pullContainer.className = "cyber-pull-container";
pullContainer.innerHTML = `
  <div class="pulse-bars">
    <div class="pulse-bar" id="bar1"></div><div class="pulse-bar" id="bar2"></div>
    <div class="pulse-bar" id="bar3"></div><div class="pulse-bar" id="bar4"></div>
  </div>
  <div class="cyber-text">Đồng bộ dữ liệu...</div>
`;
document.body.appendChild(pullContainer);

let startY = 0; 
let isPulling = false;
let isRefreshing = false;
const pullThreshold = 120; 
const textEl = pullContainer.querySelector('.cyber-text');
const bars = [
  document.getElementById('bar1'), document.getElementById('bar2'),
  document.getElementById('bar3'), document.getElementById('bar4')
];
const targetHeights = [12, 24, 16, 20]; 

window.addEventListener("touchstart", (e) => { 
  if (window.scrollY <= 0 && !isRefreshing) { startY = e.touches[0].clientY; isPulling = true; } 
}, { passive: false });

window.addEventListener("touchmove", (e) => {
  if (!isPulling || isRefreshing) return;
  const diff = e.touches[0].clientY - startY;
  
  if (diff > 0 && window.scrollY <= 0) {
    if (e.cancelable) e.preventDefault();
    const moveY = Math.min(diff * 0.4, 90); 
    pullContainer.style.top = `${-80 + moveY}px`;
    const pullRatio = Math.min(diff / pullThreshold, 1);
    
    bars.forEach((bar, index) => {
      bar.style.height = `${4 + (targetHeights[index] - 4) * pullRatio}px`;
    });
    
    if (diff > pullThreshold) {
      pullContainer.classList.add('ready'); textEl.innerText = "Thả tay để tải mới!";
    } else {
      pullContainer.classList.remove('ready'); textEl.innerText = "Kéo thêm chút nữa...";
    }
  }
}, { passive: false });

window.addEventListener("touchend", (e) => {
  if (!isPulling || isRefreshing) return;
  isPulling = false;
  const diff = e.changedTouches[0].clientY - startY;
  
  bars.forEach(bar => bar.style.height = '');
  
  if (diff > pullThreshold) {
    isRefreshing = true;
    pullContainer.classList.remove('ready');
    pullContainer.classList.add('refreshing');
    pullContainer.style.top = "20px"; 
    textEl.innerText = "Updating...";
    
    // API giờ chỉ lấy RAM cache, không kích hoạt cào
    load().then(() => {
      textEl.innerText = "Success!";
      pullContainer.classList.remove('refreshing');
      pullContainer.classList.add('ready');
      bars.forEach((bar, idx) => bar.style.height = `${targetHeights[idx]}px`);
      
      setTimeout(() => { 
        pullContainer.style.top = "-80px"; 
        setTimeout(() => { 
          isRefreshing = false; pullContainer.classList.remove('ready');
        }, 300);
      }, 1200);
    });
  } else {
    pullContainer.style.top = "-80px";
  }
});

/* ===== HỦY BỎ PWA (SERVICE WORKER) ĐỂ SỬA LỖI MẤT KẾT NỐI ===== */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then(function(registrations) {
    for(let registration of registrations) {
      registration.unregister(); 
      console.log('Đã gỡ bỏ Service Worker thành công!');
    }
  });
}