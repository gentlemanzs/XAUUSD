/* ... Giữ nguyên phần CSS ... */

<script>
const API = "/api/gold";
const HIST_API = "/api/history"; // Thêm API lịch sử
// ... elements giữ nguyên ...

let history = []; // Không lấy từ localStorage nữa

async function load() {
  elements.updateBtn.disabled = true;
  elements.updateBtn.innerText = "Updating...";
  
  try {
    // 1. Lấy dữ liệu mới nhất
    const res = await fetch(`${API}?t=${Date.now()}`);
    const d = await res.json();
    renderMain(d);
    updateChartRecord(d.diff);
    elements.lastTime.innerHTML = `🟢 Live Update: ${d.time}`;
    
    // 2. Lấy lại lịch sử đồng bộ từ Server
    const hRes = await fetch(HIST_API);
    history = await hRes.json();
    
    renderHistory();
  } catch(e) { 
    alert("Error syncing data!"); 
  } finally {
    elements.updateBtn.disabled = false;
    elements.updateBtn.innerText = "UPDATE";
  }
}

// Sửa lại hàm renderHistory để dùng biến history vừa fetch
function renderHistory() {
  elements.historyTable.innerHTML = "";
  let data = [...history].reverse(); // Lấy từ biến history toàn cục
  
  if(!isExpanded) data = data.slice(0, 5);
  
  data.forEach((r, i) => {
    const row = document.createElement("tr");
    if(i === 0 && !isExpanded) row.className = "newest";
    row.innerHTML = `
      <td>${r.time}</td>
      <td>${fmtXAU.format(r.xau)}</td>
      <td>${fmtVND.format(r.sjc)}</td>
      <td>${fmtVND.format(r.diff)}</td>
      <td><span class="badge ${r.percent.includes('-') ? 'badge-down' : 'badge-up'}">${r.percent}</span></td>
    `;
    elements.historyTable.appendChild(row);
  });
}

// Khi khởi tạo trang, load dữ liệu lần đầu
async function initData() {
  try {
    const hRes = await fetch(HIST_API);
    history = await hRes.json();
    renderHistory();
    
    const dRes = await fetch(API);
    const d = await dRes.json();
    if(d.usd) renderMain(d);
  } catch(e) { console.log("Init fail"); }
}

initChart();
initData(); 
</script>
