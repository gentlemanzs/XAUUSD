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

// Biến lưu trữ đối tượng kết nối SSE để có thể bật/tắt toàn cục
let evtSource = null;

// TỐI ƯU: Đổi từ Debounce sang Throttle (2 giây) để chặn đứng spam API
let lastFetchTime = 0;
function safeFetchHistory(isInit = false) {
  const now = Date.now();
  if (!isInit && now - lastFetchTime < 2000) return;

  lastFetchTime = now;
  fetchHistory();
}

const dateCache = new Map();

/* ===== KHỞI TẠO HOẶC KẾT NỐI LẠI SSE ===== */
function initSSE() {
  // Tránh tạo nhiều kết nối chồng chéo
  if (evtSource && evtSource.readyState !== EventSource.CLOSED) return;
  
  evtSource = new EventSource("/api/stream");

  // TỐI ƯU: Thêm log để theo dõi trình trạng kết nối thực tế
  evtSource.onopen = () => {
    console.log("🟢 SSE đã kết nối thành công");
  };

  evtSource.onmessage = (event) => {
    if (!event.data) return;
    const d = JSON.parse(event.data);
    // TỐI ƯU: Check d.updatedAt thay vì Object.keys để tiết kiệm CPU điện thoại
    if (!d?.updatedAt) return;
    
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

  // TỐI ƯU: Bắt lỗi SSE để báo hiệu cho người dùng khi rớt mạng
  evtSource.onerror = () => {
    console.warn("SSE mất kết nối, trình duyệt đang tự động thử reconnect...");
    // TỐI ƯU UX: Báo cho người dùng biết trạng thái mất mạng
    elements.lastTime.innerHTML = "🔴 Mất kết nối. Đang thử lại...";
    elements.lastTime.style.color = "var(--down-color)";
  };
}

/* ===== TẢI DỮ LIỆU (CÓ THỂ ÉP BUỘC SERVER CÀO LIỀN) ===== */
async function load() {
  try {
    // Chỉ gọi API với timestamp để chống trình duyệt lưu cache
    const res = await fetch(`${API}?t=${Date.now()}`);
    const d = await res.json();
    
    // TỐI ƯU: Giảm tải việc sinh rác bộ nhớ (Garbage Collection) trên Mobile
    if (!d?.updatedAt) return;
    
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
  // TỐI ƯU: Format 1 lần duy nhất rồi so sánh để tránh tốn CPU điện thoại
  const usdText = fmtVND.format(d.usd);
  if (elements.usd.innerText !== usdText) elements.usd.innerText = usdText;
  
  const diffText = fmtVND.format(d.diff);
  if (elements.diff.innerText !== diffText) elements.diff.innerText = diffText;
  
  if (elements.percent.innerText !== d.percent) elements.percent.innerText = d.percent;

  // --- Cập nhật ô XAU (Chống Repaint) ---
  const xChange = d.xauChange || 0;
  const isXUp = xChange >= 0;
  const xColorClass = isXUp ? 'xau-up' : 'xau-down';
  const newXauHtml = `
    <div class="xau-wrapper">
      <div>${fmtXAU.format(d.xau)}</div>
      <div class="sjc-sub ${xColorClass}">
        ${isXUp ? '▲' : '▼'} ${fmtXAU.format(Math.abs(xChange))}
      </div>
    </div>
  `;
  if (elements.xau.innerHTML !== newXauHtml) elements.xau.innerHTML = newXauHtml;

  // --- Cập nhật ô Gap Change ---
  if (elements.gapChange && d.gapChange !== undefined) {
    const gVal = d.gapChange;
    const gPrefix = gVal > 0 ? "+" : ""; 
    const newGapText = gPrefix + fmtVND.format(gVal);
    
    if (elements.gapChange.innerText !== newGapText) {
      elements.gapChange.innerText = newGapText;
      if (gVal > 0) elements.gapChange.style.color = "var(--up-color)";
      else if (gVal < 0) elements.gapChange.style.color = "var(--down-color)";
      else elements.gapChange.style.color = "var(--secondary-text)";
    }
  }

  // --- Cập nhật ô SJC (Chống Repaint) ---
  const change = d.sjcChange || 0;
  const isUp = change >= 0;
  const newSjcHtml = `
    <div>${fmtVND.format(d.sjc)}</div>
    <div class="sjc-sub ${isUp ? 'change-up' : 'change-down'}">
      ${isUp ? '▲' : '▼'} ${fmtVND.format(Math.abs(change))}
    </div>
  `;
  if (elements.sjc.innerHTML !== newSjcHtml) elements.sjc.innerHTML = newSjcHtml;

  // --- Cập nhật Status (Chống Repaint) ---
  const updateTime = new Date(d.updatedAt);
  const timeStr = isNaN(updateTime) ? new Date().toLocaleTimeString('vi-VN') : updateTime.toLocaleTimeString('vi-VN');
  const newStatusHtml = `${d.status === "Live" ? "🟢 Live" : "🟡 " + d.status} - Cập nhật: ${timeStr}`;
  if (elements.lastTime.innerHTML !== newStatusHtml) elements.lastTime.innerHTML = newStatusHtml;
}

async function fetchHistory() {
  try {
    // TỐI ƯU: Ép trình duyệt không được dùng file lưu tạm, bắt buộc phải lấy từ Server (cache RAM của ta)
    const res = await fetch(HIST_API, { cache: "no-store" });
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
// --- TỐI ƯU MỚI: Tránh tràn RAM trình duyệt ---
  if (dateCache.size > 300) {
    // TỐI ƯU: Xóa phần tử cũ nhất thay vì xóa trắng toàn bộ (Cơ chế Cuốn chiếu FIFO)
    const firstKey = dateCache.keys().next().value;
    dateCache.delete(firstKey);
  }
  
  // 3. Lưu kết quả vừa tính vào kho để lần sau không phải tính lại
  dateCache.set(isoString, formatted);

  return formatted;
}

function renderTable() {
  const pageSize = isExpanded ? 50 : 10;
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
      <td class="col-action" style="display: ${displayStyle}; text-align: center;">
        <input type="checkbox" class="log-checkbox" value="${r._id}">
      </td>
      <td style="text-align: left;">${formatVNDateTime(r.createdAt)}</td>
      <td>${fmtXAU.format(r.xau)}</td>
      <td>${fmtVND.format(r.sjc)}</td>
      <td>${fmtVND.format(r.diff)}</td>
      <td><span class="badge ${r.percent.includes('-') ? 'badge-down' : 'badge-up'}">${r.percent}</span></td>
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
  if (!isExpanded || currentData.length <= 50) { pag.style.display = "none"; return; }
  
  pag.style.display = "flex"; pag.innerHTML = "";
  const totalPages = Math.ceil(currentData.length / 50);
  
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
  
  const totalPoints = data.length;
  const labels = [];
  const gaps = [];

  // TỐI ƯU: Không tạo mảng mới bằng slice().reverse() để tiết kiệm RAM. Dùng vòng lặp ngược.
  for (let i = totalPoints - 1; i >= 0; i--) {
    const r = data[i];
    const d = new Date(r.createdAt);
    labels.push(d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }));
    gaps.push(r.diff / 1000000);
  }

  const wrapper = chartCanvas.parentElement;
  
  // TỐI ƯU: Gộp biến và tái sử dụng tránh gọi DOM 2 lần
  const scrollContainer = document.querySelector('.chart-scroll-container');
  const containerWidth = scrollContainer.clientWidth || window.innerWidth;

  const maxSpacing = 110; 
  let minSpacing = 75;  

  // TỐI ƯU CHỐNG SẬP: Giới hạn Canvas không vượt mốc 30,000px để chứa an toàn 1000 điểm
  if (totalPoints * minSpacing > 30000) {
    minSpacing = Math.floor(30000 / totalPoints);
  }
  
  const minPointsToFill = Math.ceil(containerWidth / maxSpacing);

  // --- TRỊ DỨT ĐIỂM BỆNH KÉO GIÃN & LỆCH LỀ PHẢI KHI DỮ LIỆU ÍT ---
  if (totalPoints > 0 && totalPoints < minPointsToFill) {
    const padCount = minPointsToFill - totalPoints;
    for (let i = 0; i < padCount; i++) {
      // SỬA LỖI CHÍ MẠNG CHART.JS: 
      // Chart.js tự động gộp các nhãn trùng lặp. Nếu push(''), nó sẽ gộp thành 1 cột.
      // Cần tạo ra các chuỗi khoảng trắng có độ dài khác nhau (' ', '  ', '   ') 
      // để ép Chart.js vẽ các cột tàng hình riêng biệt bên phải.
      labels.push(' '.repeat(i + 1)); 
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

    // TỐI ƯU: Dùng Math.max để đảm bảo biểu đồ luôn có độ phồng (padding) tối thiểu là 0.5M
    const padding = Math.max(range * 0.2, 0.5); 
    
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
        animation: false, // TỐI ƯU: Tắt hiệu ứng để đồ thị hiện ra ngay lập tức, tránh giật lag trên Mobile
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
            // Bật autoSkip để nhãn không đè lên nhau khi không gian bị ép nhỏ lại (do có quá nhiều điểm)
            ticks: { autoSkip: true, maxRotation: 0, color: '#64748b', font: { size: 10 } },
            grid: { display: false }
          }
        }
      }
    });
  }
  
  // TỐI ƯU: Check xem người dùng có đang ở sát mép phải (sai số 50px) không
  const isAtRightEdge = scrollContainer.scrollWidth - scrollContainer.clientWidth <= scrollContainer.scrollLeft + 50;
  
  requestAnimationFrame(() => {
    // TỐI ƯU UX: Chỉ tự động cuộn đến biểu đồ mới nhất nếu họ đang ở mép phải
    if (isAtRightEdge || data.length <= 10) {
      // Ép chặt cuộn về 0 (lề trái) nếu dữ liệu ít đang bị ép sang trái, ngược lại cuộn phải
      scrollContainer.scrollLeft = (totalPoints < minPointsToFill) ? 0 : scrollContainer.scrollWidth;
    }
  });
}

// Khởi tạo luồng SSE lắng nghe dữ liệu Realtime
initSSE();
// Fallback: nếu sau 3s SSE chưa push gì thì mới gọi REST
setTimeout(() => { if (!lastSJCValue) load(); }, 3000);

/* ===== HIỆU ỨNG PULL TO REFRESH ===== */
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

// TỐI ƯU: Chỉnh passive: true để trình duyệt bớt gánh nặng khi bắt đầu chạm màn hình
window.addEventListener("touchstart", (e) => { 
  if (window.scrollY <= 0 && !isRefreshing) { startY = e.touches[0].clientY; isPulling = true; } 
}, { passive: true });

// Touchmove bắt buộc phải có passive: false vì sử dụng preventDefault() để chặn cuộn mặc định
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
}, { passive: true }); // TỐI ƯU: Passive true cho touchend

/* ===== TỐI ƯU UX & PIN: TỰ NGẮT KẾT NỐI KHI CHUYỂN TAB ===== */
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    // Khi người dùng cất app đi, ngắt kết nối SSE để đỡ ngốn Pin
    if (evtSource) {
      evtSource.close();
      evtSource = null;
      console.log("⏸ Tab ẩn. Đã tạm ngắt SSE để tiết kiệm pin.");
    }
  } else {
    // Khi người dùng bật tab lên lại
    console.log("▶ Tab hoạt động. Đang kết nối và tải lại dữ liệu mới nhất...");
    // 1. Gọi lại hàm load() để lấy mẻ data mới nhất khỏi bị trễ nhịp
    load();
    // 2. Mở lại luồng sự kiện SSE
    initSSE();
  }
});