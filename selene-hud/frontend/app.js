/* SELENE HUD frontend — polls /api/state and paints the HUD. No build step. */
(() => {
  "use strict";

  const params = new URLSearchParams(location.search);
  const DEMO = params.has("demo");
  const POLL_MS = 2000;
  const $ = (id) => document.getElementById(id);
  const css = getComputedStyle(document.documentElement);
  const C = (name) => css.getPropertyValue(name).trim();

  // ------------------------------------------------------------- formatting
  const fmtBytes = (b, digits = 1) => {
    if (b == null || isNaN(b)) return "--";
    const u = ["B", "KB", "MB", "GB", "TB", "PB"];
    let i = 0;
    while (Math.abs(b) >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return `${b.toFixed(i === 0 ? 0 : digits)} ${u[i]}`;
  };
  const fmtRate = (b) => (b == null ? "--" : `${fmtBytes(b)}/s`);
  const fmtDuration = (s) => {
    if (s == null) return "--";
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m` : `${m}m`;
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const level = (v, warn, crit) => (v >= crit ? "crit" : v >= warn ? "warn" : "");
  const setText = (id, v) => { const el = $(id); if (el && el.textContent !== String(v)) el.textContent = v; };

  // ------------------------------------------------------------- boot
  const bootLines = [
    ["SELENE BIOS v4.2 ............................", "ok", "OK"],
    ["Mounting lunar telemetry bus ...............", "ok", "OK"],
    ["Handshake with docker.sock .................", "ok", "LINKED"],
    ["Calibrating thermal array ..................", "ok", "OK"],
    ["Indexing media vaults [MUSIC] [PHOTOS] .....", "ok", "OK"],
    ["Probing service mesh .......................", "ok", "OK"],
    ["Pinging CRATERPI ...........................", "ok", "ACK"],
    ["Loading HUD :: purple/burgundy profile .....", "rose", "READY"],
    ["", "", ""],
    ["Good evening. All systems are at your disposal.", "", ""],
  ];
  const boot = {
    done: false,
    start: performance.now(),
    run() {
      if (params.has("noboot")) return this.finish();
      const log = $("boot-log"), bar = $("boot-progress");
      const hour = new Date().getHours();
      bootLines[bootLines.length - 1][0] = `${hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening"}. All systems are at your disposal.`;
      let i = 0;
      const step = () => {
        if (this.done) return;
        if (i < bootLines.length) {
          const [txt, cls, res] = bootLines[i];
          log.insertAdjacentHTML("beforeend", `${esc(txt)} ${res ? `<span class="${cls}">[${res}]</span>` : ""}\n`);
          log.scrollTop = log.scrollHeight;
          bar.style.width = `${((i + 1) / bootLines.length) * 100}%`;
          i++;
          setTimeout(step, 180 + Math.random() * 160);
        } else {
          setTimeout(() => this.finish(), 650);
        }
      };
      step();
      $("boot").addEventListener("click", () => this.finish());
    },
    finish() {
      if (this.done) return;
      this.done = true;
      $("boot").classList.add("done");
      document.body.classList.add("ready");
      setTimeout(() => { $("boot").remove(); resizeCanvases(); }, 900);
    },
  };

  // ------------------------------------------------------------- clock
  function tickClock() {
    const now = new Date();
    setText("clock-time", now.toLocaleTimeString([], { hour12: false }));
    setText("clock-date", now.toLocaleDateString([], { weekday: "short", day: "2-digit", month: "short", year: "numeric" }).toUpperCase());
  }

  // ------------------------------------------------------------- canvases
  const canvases = {};
  function setupCanvas(id) {
    const el = $(id);
    const ctx = el.getContext("2d");
    canvases[id] = { el, ctx, w: 0, h: 0 };
    return canvases[id];
  }
  function resizeCanvases() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (const c of Object.values(canvases)) {
      const r = c.el.getBoundingClientRect();
      c.w = r.width; c.h = r.height;
      c.el.width = Math.round(r.width * dpr); c.el.height = Math.round(r.height * dpr);
      c.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    if (last) drawCharts(last);
  }

  function drawSpark(id, values, color, max = 100) {
    const c = canvases[id];
    if (!c || !c.w) return;
    const { ctx, w, h } = c;
    ctx.clearRect(0, 0, w, h);
    const v = values.filter((x) => x != null);
    if (v.length < 2) return;
    const n = values.length, pad = 2;
    const x = (i) => (i / (n - 1)) * w;
    const y = (val) => h - pad - (Math.min(val, max) / max) * (h - pad * 2);
    ctx.beginPath();
    values.forEach((val, i) => { if (val != null) (i ? ctx.lineTo : ctx.moveTo).call(ctx, x(i), y(val)); });
    ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, color + "55"); g.addColorStop(1, color + "00");
    ctx.fillStyle = g; ctx.fill();
  }

  let netHover = null;
  function drawNet(hist) {
    const c = canvases["net-chart"];
    if (!c || !c.w) return;
    const { ctx, w, h } = c;
    ctx.clearRect(0, 0, w, h);
    const rx = hist.rx || [], tx = hist.tx || [], t = hist.t || [];
    const n = rx.length;
    const padL = 54, padB = 16, padT = 6, pw = w - padL, ph = h - padB - padT;
    const max = Math.max(1024, ...rx, ...tx) * 1.15;

    // recessive grid + y labels
    ctx.font = `10px ${C("--font-mono")}`;
    ctx.textBaseline = "middle";
    for (let i = 0; i <= 3; i++) {
      const yy = padT + (ph * i) / 3;
      ctx.strokeStyle = "rgba(178,107,255,.10)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w, yy); ctx.stroke();
      ctx.fillStyle = C("--muted");
      ctx.fillText(fmtRate(max * (1 - i / 3)).replace(" ", ""), 2, yy);
    }
    ctx.fillStyle = C("--muted"); ctx.textBaseline = "alphabetic";
    ctx.fillText(`-${Math.round(((t[n - 1] || 0) - (t[0] || 0)) / 60) || 0}m`, padL, h - 3);
    ctx.textAlign = "right"; ctx.fillText("now", w, h - 3); ctx.textAlign = "left";
    if (n < 2) return;

    const x = (i) => padL + (i / (n - 1)) * pw;
    const y = (v) => padT + ph - (v / max) * ph;
    for (const [series, color] of [[rx, C("--series-rx")], [tx, C("--series-tx")]]) {
      ctx.beginPath();
      series.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.stroke();
      ctx.lineTo(x(n - 1), padT + ph); ctx.lineTo(x(0), padT + ph); ctx.closePath();
      const g = ctx.createLinearGradient(0, padT, 0, padT + ph);
      g.addColorStop(0, color + "40"); g.addColorStop(1, color + "00");
      ctx.fillStyle = g; ctx.fill();
    }

    const tip = $("net-tip");
    if (netHover != null && netHover >= padL) {
      const i = Math.max(0, Math.min(n - 1, Math.round(((netHover - padL) / pw) * (n - 1))));
      const xx = x(i);
      ctx.strokeStyle = "rgba(241,231,255,.35)"; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(xx, padT); ctx.lineTo(xx, padT + ph); ctx.stroke(); ctx.setLineDash([]);
      for (const [v, color] of [[rx[i], C("--series-rx")], [tx[i], C("--series-tx")]]) {
        ctx.beginPath(); ctx.arc(xx, y(v), 4, 0, Math.PI * 2);
        ctx.fillStyle = color; ctx.fill(); ctx.strokeStyle = C("--bg-2"); ctx.lineWidth = 2; ctx.stroke();
      }
      const time = t[i] ? new Date(t[i] * 1000).toLocaleTimeString([], { hour12: false }) : "";
      tip.innerHTML = `<div>${time}</div>
        <div class="tt-row"><i class="sw sw-rx"></i>Down&nbsp;<b>${fmtRate(rx[i])}</b></div>
        <div class="tt-row"><i class="sw sw-tx"></i>Up&nbsp;<b>${fmtRate(tx[i])}</b></div>`;
      tip.style.left = `${Math.min(xx + 10, w - tip.offsetWidth - 4)}px`;
      tip.style.top = "4px";
      tip.classList.add("show");
    } else {
      tip.classList.remove("show");
    }
  }

  function drawCharts(s) {
    const h = s.history || {};
    drawSpark("spark-cpu", h.cpu || [], C("--purple"));
    drawSpark("spark-mem", h.mem || [], C("--rose"));
    drawNet(h);
  }

  // ------------------------------------------------------------- render
  let last = null;
  const gauge = (id, pct, lvl) => {
    const el = $(id);
    el.style.strokeDasharray = `${(Math.max(0, Math.min(100, pct || 0)) * 0.75).toFixed(2)} 100`;
    el.classList.toggle("warn", lvl === "warn");
    el.classList.toggle("crit", lvl === "crit");
  };

  function renderSystem(s) {
    const sys = s.system || {}, meta = s.meta || {};
    if (!sys.cpu) return;
    const cpu = sys.cpu, mem = sys.memory, swap = sys.swap;

    setText("cpu-pct", Math.round(cpu.percent));
    setText("cpu-model", (meta.cpu_model || "").replace(/\(R\)|\(TM\)|CPU /g, "").replace(/\s+/g, " "));
    setText("cpu-freq", cpu.freq ? `${(cpu.freq / 1000).toFixed(2)} GHz` : "--");
    setText("cpu-load", cpu.load ? cpu.load.map((x) => x.toFixed(2)).join(" ") : "--");
    setText("proc-count", sys.processes?.count ?? "--");

    const cores = $("cores");
    if (cores.children.length !== cpu.per_core.length) {
      cores.innerHTML = cpu.per_core.map((_, i) => `<div class="core"><i></i><span>C${i}</span></div>`).join("");
    }
    cpu.per_core.forEach((v, i) => { cores.children[i].firstChild.style.height = `${v}%`; });

    setText("mem-total", fmtBytes(mem.total, 0));
    setText("mem-text", `${fmtBytes(mem.used)} · ${mem.percent.toFixed(0)}%`);
    $("mem-bar").style.width = `${mem.percent}%`;
    $("mem-bar").parentElement.className = `meter ${level(mem.percent, 80, 92)}`;
    setText("swap-text", swap.total ? `${fmtBytes(swap.used)} / ${fmtBytes(swap.total)}` : "none");
    $("swap-bar").style.width = `${swap.percent || 0}%`;
    setText("cache-text", fmtBytes((mem.cached || 0) + (mem.buffers || 0)));

    // reactor gauges
    const temp = cpu.temp;
    gauge("g-cpu", cpu.percent, level(cpu.percent, 75, 90));
    gauge("g-mem", mem.percent, level(mem.percent, 80, 92));
    gauge("g-temp", temp ?? 0, level(temp ?? 0, 75, 88));
    setText("gl-cpu", `${Math.round(cpu.percent)}%`);
    setText("gl-mem", `${Math.round(mem.percent)}%`);
    setText("gl-temp", temp != null ? `${Math.round(temp)}°C` : "n/a");

    // thermals
    const temps = (sys.temps || []).filter((t) => !/^CPU Core/.test(t.label) || (sys.temps.length < 8));
    $("temps").innerHTML = temps.length ? temps.map((t) => {
      const crit = t.critical || 100, pct = Math.min(100, (t.current / crit) * 100);
      const lv = level(t.current, (t.high || crit) - 10, t.high || crit - 5);
      const circ = 2 * Math.PI * 15;
      return `<div class="temp ${lv}"><svg viewBox="0 0 38 38"><circle class="t-track" cx="19" cy="19" r="15"/>
        <circle class="t-val" cx="19" cy="19" r="15" transform="rotate(-90 19 19)" stroke-dasharray="${(pct / 100) * circ} ${circ}"/></svg>
        <div><b>${t.current.toFixed(0)}°</b><small>${esc(t.label)}</small></div></div>`;
    }).join("") : `<div class="empty">No sensors exposed</div>`;

    // processes
    $("procs").tBodies[0].innerHTML = (sys.processes?.top || []).map((p) =>
      `<tr><td>${p.pid}</td><td>${esc(p.name)}</td><td class="num">${p.cpu.toFixed(1)}%</td><td class="num">${fmtBytes(p.mem, 0)}</td></tr>`).join("");

    // network
    const nets = sys.network || [];
    const rx = nets.reduce((a, n) => a + n.rx, 0), tx = nets.reduce((a, n) => a + n.tx, 0);
    setText("net-rx", fmtRate(rx)); setText("net-tx", fmtRate(tx));
    $("ifaces").innerHTML = nets.map((n) =>
      `<span class="iface">${n.up ? "▲" : "▼"} <b>${esc(n.name)}</b> ${esc(n.ip)} ${n.speed ? `· ${n.speed >= 1000 ? n.speed / 1000 + "G" : n.speed + "M"}` : ""} · Σ ${fmtBytes(n.total_rx + n.total_tx, 0)}</span>`).join("");

    // disk io
    $("diskio").innerHTML = (sys.disk_io || []).map((d) =>
      `<div class="dio"><header>${esc(d.name)}</header>
        <div class="row"><span>READ</span><b>${fmtRate(d.read)}</b></div>
        <div class="row"><span>WRITE</span><b>${fmtRate(d.write)}</b></div></div>`).join("") || `<div class="empty">No block devices</div>`;

    // storage
    const disks = sys.disks || [];
    const totalUsed = disks.reduce((a, d) => a + (d.used || 0), 0), total = disks.reduce((a, d) => a + (d.total || 0), 0);
    setText("storage-summary", total ? `${fmtBytes(totalUsed, 1)} / ${fmtBytes(total, 1)}` : "--");
    $("disks").innerHTML = disks.map((d) => d.mounted ? `
      <div class="disk"><header><span>${esc(d.name)}</span><span>${fmtBytes(d.used)} / ${fmtBytes(d.total)} · ${d.percent.toFixed(0)}%</span></header>
        <div class="meter ${level(d.percent, 80, 90)}"><i style="width:${d.percent}%"></i></div>
        <div class="path">${esc(d.path)} · ${fmtBytes(d.free)} free</div></div>` : `
      <div class="disk unmounted"><header><span>${esc(d.name)}</span><span>⚠ NOT MOUNTED</span></header>
        <div class="meter crit"><i style="width:0"></i></div><div class="path">${esc(d.path)}</div></div>`).join("");

    setText("uptime", fmtDuration(sys.uptime));
  }

  function renderDocker(s) {
    const d = s.docker || {};
    const box = $("containers");
    if (!d.available) {
      setText("docker-count", "OFFLINE");
      setText("docker-version", "API UNREACHABLE");
      box.innerHTML = `<div class="empty">Docker API unreachable${d.error ? ` — ${esc(d.error)}` : ""}</div>`;
      return;
    }
    setText("docker-count", `${d.running}/${d.total}`);
    setText("docker-version", `ENGINE ${d.version || "?"} · ${d.running} RUNNING`);
    box.innerHTML = d.containers.map((c) => {
      const running = c.state === "running";
      const memPct = c.mem_limit ? (c.mem / c.mem_limit) * 100 : 0;
      const health = c.health ? ` · ${c.health.toUpperCase()}` : "";
      const uptime = (c.status || "").replace(/\s*\(.*\)/, "").replace(/^Up /, "");
      return `<div class="ctr ${running ? "" : "stopped"}" title="${esc(c.image)}">
        <div class="c-top"><span class="c-name">${esc(c.name)}</span><span class="c-state">${running ? "●" : "⚠"}</span></div>
        <div class="c-sub">${esc(c.state.toUpperCase())}${esc(health)}</div>
        ${running ? `<div class="c-bars">
          <span>CPU</span><div class="c-bar"><i style="width:${Math.min(100, (c.cpu || 0) / (s.meta?.threads || 1))}%"></i></div><span>${(c.cpu || 0).toFixed(1)}%</span>
          <span>MEM</span><div class="c-bar mem"><i style="width:${Math.min(100, memPct * 4)}%"></i></div><span>${fmtBytes(c.mem, 0)}</span>
        </div>` : ""}
        <div class="c-foot">${running ? `up ${esc(uptime)}` : esc(c.status)}${c.ports?.length ? ` · :${c.ports.slice(0, 3).join(" :")}` : ""}</div>
      </div>`;
    }).join("") || `<div class="empty">No containers</div>`;
  }

  function renderServices(s) {
    const containers = Object.fromEntries((s.docker?.containers || []).map((c) => [c.name, c]));
    const svcs = (s.services || []).map((sv) => {
      const c = sv.container ? containers[sv.container] : null;
      // Up if the HTTP probe answered; with no URL, fall back to container state.
      let up = sv.up;
      if (up == null && c) up = c.state === "running";
      if (up && c && c.state !== "running") up = false;
      return { ...sv, up, c };
    });
    const ok = svcs.filter((x) => x.up).length;
    setText("svc-summary", `${ok}/${svcs.length} ONLINE`);
    let lastGroup = null;
    $("services").innerHTML = svcs.map((sv) => {
      const cls = sv.up === true ? "" : sv.up === false ? "down" : "unknown";
      const groupHead = sv.group !== lastGroup ? `<div class="svc-group">// ${esc(sv.group)}</div>` : "";
      lastGroup = sv.group;
      const meta = sv.latency != null ? `${sv.latency} ms` : sv.c?.cpu != null ? `${sv.c.cpu.toFixed(1)}% cpu` : "";
      const st = sv.up === true ? "ONLINE" : sv.up === false ? "OFFLINE" : "UNKNOWN";
      const ico = sv.up === true ? "◆" : sv.up === false ? "⚠" : "◇";
      return `${groupHead}<div class="svc ${cls}"><span class="ico">${ico}</span><span class="name">${esc(sv.name)}</span><span class="meta">${meta}</span><span class="state">${st}</span></div>`;
    }).join("") || `<div class="empty">No services configured</div>`;
  }

  function renderNodes(s) {
    const hex = `<svg class="hex" viewBox="0 0 22 24"><polygon points="11,1 21,6.5 21,17.5 11,23 1,17.5 1,6.5"/></svg>`;
    $("nodes").innerHTML = (s.nodes || []).map((n) =>
      `<div class="node ${n.up ? "" : "down"}">${hex}<span class="n-name">${esc(n.name)}</span>
        <span class="n-meta">${esc(n.address)} · ${n.up ? `${n.latency} ms` : "⚠ UNREACHABLE"}</span></div>`).join("") || `<div class="empty">No nodes configured</div>`;
    const nfs = s.nfs || {};
    const exp = (nfs.exports || []).map((e) => `<div>⇄ <b>${esc(e.path)}</b> → ${e.clients.map(esc).join(", ")}</div>`).join("");
    const clients = nfs.clients?.length ? `<div>ACTIVE CLIENTS: <b>${nfs.clients.map(esc).join(", ")}</b></div>` : "";
    $("nfs").innerHTML = exp || clients ? exp + clients : `<div class="muted">No NFS exports found</div>`;
  }

  function renderStatus(s) {
    const alerts = s.alerts || [];
    const worst = alerts.some((a) => a.level === "critical") ? "crit" : alerts.length ? "warn" : "";
    const state = $("core-state");
    state.textContent = worst === "crit" ? "ALERT" : worst === "warn" ? "CAUTION" : "NOMINAL";
    state.setAttribute("class", `core-state ${worst}`);
    setText("core-name", s.meta?.name || "SELENE");
    setText("host-ip", s.meta?.ip || "--");

    const ticker = $("ticker");
    const html = alerts.length
      ? alerts.map((a) => `<span class="${a.level === "critical" ? "crit" : "warn"}">⚠ ${esc(a.message.toUpperCase())}</span>`).join('<span class="sep">//</span>')
      : `ALL SYSTEMS NOMINAL<span class="sep">//</span>${esc(s.meta?.name || "")} · ${esc(s.meta?.os || "")} · KERNEL ${esc(s.meta?.kernel || "")}<span class="sep">//</span>${s.docker?.running ?? 0} CONTAINERS RUNNING<span class="sep">//</span>${(s.services || []).length} SERVICES MONITORED`;
    if (ticker.dataset.html !== html) { ticker.innerHTML = html; ticker.dataset.html = html; }
    ticker.closest(".ticker").classList.toggle("alerting", worst === "crit");
  }

  function render(s) {
    last = s;
    renderSystem(s);
    renderDocker(s);
    renderServices(s);
    renderNodes(s);
    renderStatus(s);
    drawCharts(s);
  }

  // ------------------------------------------------------------- data
  async function poll() {
    const pill = $("link-pill");
    try {
      const s = DEMO ? demo.next() : await (await fetch("api/state", { cache: "no-store" })).json();
      render(s);
      pill.className = "pill live"; pill.lastElementChild.textContent = DEMO ? "DEMO" : "LIVE";
    } catch (e) {
      pill.className = "pill lost"; pill.lastElementChild.textContent = "LINK LOST";
    }
    setTimeout(poll, POLL_MS);
  }

  // Simulated data so the HUD can be previewed anywhere with ?demo
  const demo = (() => {
    const GB = 1024 ** 3, TB = 1024 ** 4;
    const hist = { t: [], cpu: [], mem: [], temp: [], rx: [], tx: [] };
    const now = () => Date.now() / 1000;
    let cpu = 18, mem = 54, rx = 2e6, tx = 4e5;
    const walk = (v, lo, hi, step) => Math.max(lo, Math.min(hi, v + (Math.random() - 0.5) * step));
    for (let i = 300; i > 0; i--) push(now() - i * 2);
    function push(t) {
      cpu = walk(cpu, 4, 85, 10); mem = walk(mem, 48, 62, 1.2);
      rx = Math.max(5e4, walk(rx, 0, 3e7, 3e6) * (Math.random() < 0.03 ? 4 : 1)); tx = walk(tx, 2e4, 6e6, 4e5);
      hist.t.push(Math.round(t)); hist.cpu.push(+cpu.toFixed(1)); hist.mem.push(+mem.toFixed(1));
      hist.temp.push(+(38 + cpu * 0.35).toFixed(1)); hist.rx.push(rx); hist.tx.push(tx);
      for (const k in hist) if (hist[k].length > 300) hist[k].shift();
    }
    const ctr = (name, image, c, m, ports = [], extra = {}) => ({ name, image, state: "running", status: "Up 6 days (healthy)", health: "healthy", cpu: c, mem: m * 1024 ** 2, mem_limit: 16 * GB, ports, ...extra });
    return {
      next() {
        push(now());
        const cores = [0, 1, 2, 3].map(() => +walk(cpu, 0, 100, 25).toFixed(1));
        const temp = 38 + cpu * 0.35;
        return {
          time: now(),
          meta: { name: "SELENE", ip: "192.168.68.105", os: "Ubuntu 24.04.1 LTS", kernel: "6.8.0-45-generic", cpu_model: "Intel(R) Core(TM) i3-6100 CPU @ 3.70GHz", cores: 2, threads: 4 },
          system: {
            cpu: { percent: +cpu.toFixed(1), per_core: cores, freq: 3700, load: [cpu / 25, cpu / 28, cpu / 30], temp: +temp.toFixed(1) },
            memory: { total: 16 * GB, used: (mem / 100) * 16 * GB, percent: +mem.toFixed(1), cached: 4.2 * GB, buffers: 0.3 * GB },
            swap: { total: 4 * GB, used: 0.2 * GB, percent: 5 },
            temps: [
              { label: "CPU Package", current: temp, high: 84, critical: 100 },
              { label: "CPU Core 0", current: temp - 2, high: 84, critical: 100 },
              { label: "CPU Core 1", current: temp - 1, high: 84, critical: 100 },
              { label: "NVMe Composite", current: 41, high: 80, critical: 85 },
              { label: "acpitz", current: 27.8, high: null, critical: 105 },
            ],
            disks: [
              { name: "SYSTEM NVMe", path: "/", mounted: true, total: 476 * GB, used: 132 * GB, free: 344 * GB, percent: 27.7 },
              { name: "MUSIC", path: "/mnt/music", mounted: true, total: 1.82 * TB, used: 1.31 * TB, free: 0.51 * TB, percent: 72 },
              { name: "PHOTOS", path: "/mnt/photos", mounted: true, total: 0.93 * TB, used: 0.79 * TB, free: 0.14 * TB, percent: 85 },
            ],
            disk_io: [
              { name: "nvme0n1", read: Math.random() * 4e6, write: Math.random() * 2e6 },
              { name: "sda", read: Math.random() * 9e6, write: Math.random() * 1e5 },
              { name: "sdb", read: Math.random() * 2e5, write: Math.random() * 3e5 },
            ],
            network: [{ name: "enp0s31f6", rx, tx, up: true, speed: 1000, ip: "192.168.68.105", total_rx: 3.1 * TB, total_tx: 0.9 * TB }],
            processes: { count: 312, top: [
              { pid: 2211, name: "immich-server", cpu: 9.4, mem: 1.1 * GB }, { pid: 1840, name: "navidrome", cpu: 3.1, mem: 210e6 },
              { pid: 1977, name: "slskd", cpu: 2.6, mem: 380e6 }, { pid: 2034, name: "Lidarr", cpu: 1.8, mem: 420e6 },
              { pid: 1120, name: "pihole-FTL", cpu: 0.9, mem: 60e6 }, { pid: 2502, name: "seanime", cpu: 0.7, mem: 150e6 },
              { pid: 980, name: "dockerd", cpu: 0.5, mem: 110e6 }, { pid: 3101, name: "postgres", cpu: 0.4, mem: 260e6 },
            ] },
            uptime: 18 * 86400 + 7 * 3600 + 23 * 60,
          },
          docker: { available: true, version: "27.3.1", running: 11, total: 12, containers: [
            ctr("immich_server", "ghcr.io/immich-app/immich-server", 9.4, 1100, [2283]),
            ctr("immich_machine_learning", "ghcr.io/immich-app/immich-machine-learning", 0.3, 780),
            ctr("immich_postgres", "tensorchord/pgvecto-rs", 0.4, 260),
            ctr("immich_redis", "redis:6.2-alpine", 0.2, 12),
            ctr("lidarr", "lscr.io/linuxserver/lidarr", 1.8, 420, [8686]),
            ctr("navidrome", "deluan/navidrome", 3.1, 210, [4533]),
            ctr("pihole", "pihole/pihole", 0.9, 60, [53, 80]),
            ctr("pihole2", "pihole/pihole", 0.6, 55, [5353, 8081]),
            ctr("pkvault", "pkvault", 0.1, 90, [8090], { health: null, status: "Up 2 days" }),
            ctr("seanime", "seanime", 0.7, 150, [43211], { health: null, status: "Up 6 days" }),
            ctr("slskd", "slskd/slskd", 2.6, 380, [5030]),
            { name: "soularr", image: "mrusse08/soularr", state: "exited", status: "Exited (1) 14 minutes ago", ports: [] },
          ] },
          services: [
            { name: "Navidrome", group: "MUSIC", container: "navidrome", up: true, latency: 4 },
            { name: "Lidarr", group: "MUSIC", container: "lidarr", up: true, latency: 11 },
            { name: "slskd", group: "MUSIC", container: "slskd", up: true, latency: 7 },
            { name: "Soularr", group: "MUSIC", container: "soularr", up: null },
            { name: "Immich", group: "PHOTOS", container: "immich_server", up: true, latency: 18 },
            { name: "Seanime", group: "MEDIA", container: "seanime", up: true, latency: 9 },
            { name: "PKVault", group: "TOOLS", container: "pkvault", up: true, latency: 6 },
            { name: "Pi-hole", group: "NETWORK", container: "pihole", up: true, latency: 3 },
            { name: "Pi-hole 2", group: "NETWORK", container: "pihole2", up: true, latency: 3 },
          ],
          nodes: [
            { name: "SELENE", address: "127.0.0.1", up: true, latency: 0 },
            { name: "CRATERPI", address: "192.168.68.110", up: true, latency: 2 },
          ],
          nfs: { exports: [{ path: "/mnt/music", clients: ["192.168.68.110"] }], clients: ["192.168.68.110"] },
          alerts: [{ level: "critical", message: "Container soularr is exited" }],
          history: hist,
        };
      },
    };
  })();

  // ------------------------------------------------------------- init
  ["spark-cpu", "spark-mem", "net-chart"].forEach(setupCanvas);
  const net = $("net-chart");
  net.addEventListener("pointermove", (e) => { netHover = e.clientX - net.getBoundingClientRect().left; if (last) drawNet(last.history || {}); });
  net.addEventListener("pointerleave", () => { netHover = null; if (last) drawNet(last.history || {}); });
  window.addEventListener("resize", resizeCanvases);

  tickClock(); setInterval(tickClock, 1000);
  resizeCanvases();
  boot.run();
  poll();

})();
