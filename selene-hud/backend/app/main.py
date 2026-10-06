"""SELENE HUD backend.

Collects host, Docker, service and node telemetry in background loops and
serves it as one JSON document at /api/state, plus the static HUD frontend.
Everything here is read-only.
"""

import asyncio
import os
import platform
import re
import time
from collections import deque
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import psutil
import yaml
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

HOSTFS = os.environ.get("HUD_HOSTFS", "").rstrip("/")
CONFIG_PATH = Path(os.environ.get("HUD_CONFIG", "/config/hud.yaml"))
DOCKER_SOCK = os.environ.get("HUD_DOCKER_SOCK", "/var/run/docker.sock")
FRONTEND_DIR = Path(os.environ.get("HUD_FRONTEND", Path(__file__).parent.parent.parent / "frontend"))

SYSTEM_INTERVAL = 2
DOCKER_INTERVAL = 5
PROBE_INTERVAL = 15
HISTORY_LEN = 300  # 10 minutes at SYSTEM_INTERVAL

PHYSICAL_DISK = re.compile(r"^(nvme\d+n\d+|sd[a-z]+|vd[a-z]+|mmcblk\d+)$")


def load_config() -> dict:
    try:
        return yaml.safe_load(CONFIG_PATH.read_text()) or {}
    except FileNotFoundError:
        return {}


def host_path(path: str) -> str:
    return f"{HOSTFS}{path}" if HOSTFS else path


def read_text(path: str, default: str = "") -> str:
    try:
        return Path(path).read_text()
    except OSError:
        return default


state: dict = {
    "meta": {},
    "system": {},
    "docker": {"available": False, "containers": []},
    "services": [],
    "nodes": [],
    "nfs": {},
    "history": {k: deque(maxlen=HISTORY_LEN) for k in ("t", "cpu", "mem", "temp", "rx", "tx")},
}


# ---------------------------------------------------------------- static info

def collect_meta(cfg: dict) -> dict:
    os_release = read_text(host_path("/etc/os-release"))
    pretty = re.search(r'^PRETTY_NAME="?(.*?)"?$', os_release, re.M)
    cpuinfo = read_text("/proc/cpuinfo")
    model = re.search(r"^model name\s*:\s*(.*)$", cpuinfo, re.M)
    host = cfg.get("host", {})
    return {
        "name": host.get("name", platform.node().upper()),
        "ip": host.get("ip", ""),
        "role": host.get("role", ""),
        "os": pretty.group(1) if pretty else platform.system(),
        "kernel": platform.release(),
        "cpu_model": model.group(1).strip() if model else platform.processor(),
        "cores": psutil.cpu_count(logical=False),
        "threads": psutil.cpu_count(),
        "boot_time": psutil.boot_time(),
    }


# --------------------------------------------------------------------- system

class Rates:
    """Turns monotonically increasing counters into per-second rates."""

    def __init__(self):
        self.prev: dict = {}
        self.prev_t = 0.0

    def update(self, counters: dict) -> dict:
        now = time.monotonic()
        dt = now - self.prev_t if self.prev_t else 0
        out = {}
        for key, values in counters.items():
            old = self.prev.get(key)
            out[key] = tuple(max(0.0, (v - o) / dt) for v, o in zip(values, old)) if old and dt else tuple(0.0 for _ in values)
        self.prev, self.prev_t = counters, now
        return out


net_rates = Rates()
disk_rates = Rates()


def collect_temps() -> list:
    temps = []
    try:
        sensors = psutil.sensors_temperatures()
    except (AttributeError, OSError):
        return temps
    for chip, entries in sensors.items():
        for e in entries:
            label = e.label or chip
            if chip == "coretemp" and label.startswith("Core"):
                label = f"CPU {label}"
            elif chip == "coretemp":
                label = "CPU Package"
            elif chip.startswith("nvme"):
                label = f"NVMe {e.label or ''}".strip()
            temps.append({"label": label, "chip": chip, "current": round(e.current, 1),
                          "high": e.high, "critical": e.critical})
    return temps


def collect_disks(cfg: dict) -> list:
    disks = []
    for d in cfg.get("disks", [{"name": "ROOT", "path": "/"}]):
        path = d["path"]
        real = host_path(path)
        entry = {"name": d.get("name", path), "path": path, "mounted": path == "/" or os.path.ismount(real)}
        if entry["mounted"]:
            try:
                u = psutil.disk_usage(real)
                entry.update(total=u.total, used=u.used, free=u.free, percent=u.percent)
            except OSError:
                entry["mounted"] = False
        disks.append(entry)
    return disks


def collect_processes() -> tuple:
    procs = []
    for p in psutil.process_iter(["pid", "name", "cpu_percent", "memory_info", "username"]):
        info = p.info
        if info["memory_info"] is None:
            continue
        procs.append({"pid": info["pid"], "name": info["name"], "cpu": round(info["cpu_percent"] or 0, 1),
                      "mem": info["memory_info"].rss})
    top = sorted(procs, key=lambda p: (p["cpu"], p["mem"]), reverse=True)[:8]
    return top, len(procs)


def collect_system(cfg: dict) -> dict:
    ignore = tuple(cfg.get("ignore_interfaces", ["lo", "docker", "br-", "veth"]))

    vm, sw = psutil.virtual_memory(), psutil.swap_memory()
    freq = psutil.cpu_freq()
    per_core = psutil.cpu_percent(percpu=True)

    nics = {n: (c.bytes_recv, c.bytes_sent) for n, c in psutil.net_io_counters(pernic=True).items()
            if not n.startswith(ignore)}
    nic_rates = net_rates.update(nics)
    if_stats = psutil.net_if_stats()
    if_addrs = psutil.net_if_addrs()
    interfaces = []
    for name, (rx, tx) in nic_rates.items():
        st = if_stats.get(name)
        ipv4 = next((a.address for a in if_addrs.get(name, []) if a.family.name == "AF_INET"), "")
        interfaces.append({"name": name, "rx": rx, "tx": tx, "up": bool(st and st.isup),
                           "speed": st.speed if st else 0, "ip": ipv4,
                           "total_rx": nics[name][0], "total_tx": nics[name][1]})

    io = {n: (c.read_bytes, c.write_bytes) for n, c in (psutil.disk_io_counters(perdisk=True) or {}).items()
          if PHYSICAL_DISK.match(n)}
    io_rates = [{"name": n, "read": r, "write": w} for n, (r, w) in disk_rates.update(io).items()]

    temps = collect_temps()
    cpu_temp = next((t["current"] for t in temps if t["label"] == "CPU Package"), None)
    if cpu_temp is None and temps:
        cpu_temp = max(t["current"] for t in temps)

    top, proc_count = collect_processes()

    return {
        "cpu": {"percent": round(sum(per_core) / len(per_core), 1) if per_core else 0, "per_core": per_core,
                "freq": round(freq.current) if freq else None, "freq_max": round(freq.max) if freq and freq.max else None,
                "load": [round(x, 2) for x in os.getloadavg()], "temp": cpu_temp},
        "memory": {"total": vm.total, "used": vm.total - vm.available, "percent": vm.percent,
                   "cached": getattr(vm, "cached", 0), "buffers": getattr(vm, "buffers", 0)},
        "swap": {"total": sw.total, "used": sw.used, "percent": sw.percent},
        "temps": temps,
        "disks": collect_disks(cfg),
        "disk_io": io_rates,
        "network": interfaces,
        "processes": {"count": proc_count, "top": top},
        "uptime": time.time() - psutil.boot_time(),
    }


async def system_loop():
    psutil.cpu_percent(percpu=True)
    while True:
        cfg = load_config()
        try:
            sysinfo = await asyncio.to_thread(collect_system, cfg)
            state["system"] = sysinfo
            h = state["history"]
            h["t"].append(int(time.time()))
            h["cpu"].append(sysinfo["cpu"]["percent"])
            h["mem"].append(sysinfo["memory"]["percent"])
            h["temp"].append(sysinfo["cpu"]["temp"])
            h["rx"].append(sum(i["rx"] for i in sysinfo["network"]))
            h["tx"].append(sum(i["tx"] for i in sysinfo["network"]))
        except Exception as exc:  # keep the loop alive, surface the error
            state["system_error"] = repr(exc)
        await asyncio.sleep(SYSTEM_INTERVAL)


# --------------------------------------------------------------------- docker

def container_cpu(stats: dict) -> float:
    cpu, pre = stats.get("cpu_stats", {}), stats.get("precpu_stats", {})
    cpu_delta = cpu.get("cpu_usage", {}).get("total_usage", 0) - pre.get("cpu_usage", {}).get("total_usage", 0)
    sys_delta = cpu.get("system_cpu_usage", 0) - pre.get("system_cpu_usage", 0)
    ncpu = cpu.get("online_cpus") or len(cpu.get("cpu_usage", {}).get("percpu_usage") or [1])
    return round(cpu_delta / sys_delta * ncpu * 100, 1) if sys_delta > 0 and cpu_delta > 0 else 0.0


def container_mem(stats: dict) -> tuple:
    mem = stats.get("memory_stats", {})
    usage = mem.get("usage", 0)
    cache = mem.get("stats", {}).get("inactive_file", mem.get("stats", {}).get("cache", 0))
    return max(0, usage - cache), mem.get("limit", 0)


async def docker_loop():
    transport = httpx.AsyncHTTPTransport(uds=DOCKER_SOCK)
    async with httpx.AsyncClient(transport=transport, base_url="http://docker", timeout=10) as client:
        info_cache: dict = {}
        while True:
            try:
                if not info_cache:
                    v = (await client.get("/version")).json()
                    info_cache = {"version": v.get("Version"), "api": v.get("ApiVersion")}
                containers = (await client.get("/containers/json", params={"all": "true"})).json()

                async def stats_for(c):
                    if c["State"] != "running":
                        return c, None
                    try:
                        r = await client.get(f"/containers/{c['Id']}/stats", params={"stream": "false"})
                        return c, r.json()
                    except httpx.HTTPError:
                        return c, None

                results = await asyncio.gather(*(stats_for(c) for c in containers))
                out = []
                for c, st in results:
                    status = c.get("Status", "")
                    health = "healthy" if "(healthy)" in status else "unhealthy" if "(unhealthy)" in status else \
                             "starting" if "health: starting" in status else None
                    entry = {"name": c["Names"][0].lstrip("/"), "image": c["Image"], "state": c["State"],
                             "status": status, "health": health, "created": c.get("Created"),
                             "ports": sorted({p["PublicPort"] for p in c.get("Ports", []) if p.get("PublicPort")}),
                             "project": c.get("Labels", {}).get("com.docker.compose.project")}
                    if st:
                        used, limit = container_mem(st)
                        nets = st.get("networks") or {}
                        entry.update(cpu=container_cpu(st), mem=used, mem_limit=limit,
                                     net_rx=sum(n.get("rx_bytes", 0) for n in nets.values()),
                                     net_tx=sum(n.get("tx_bytes", 0) for n in nets.values()),
                                     pids=st.get("pids_stats", {}).get("current"))
                    out.append(entry)
                out.sort(key=lambda e: (e["state"] != "running", e["name"]))
                state["docker"] = {"available": True, **info_cache, "containers": out,
                                   "running": sum(e["state"] == "running" for e in out), "total": len(out)}
            except (httpx.HTTPError, OSError) as exc:
                state["docker"] = {"available": False, "error": str(exc), "containers": []}
                info_cache = {}
            await asyncio.sleep(DOCKER_INTERVAL)


# --------------------------------------------------------------- probes / NFS

async def probe_http(client: httpx.AsyncClient, url: str) -> dict:
    start = time.perf_counter()
    try:
        r = await client.get(url)
        return {"up": r.status_code < 500, "code": r.status_code,
                "latency": round((time.perf_counter() - start) * 1000)}
    except httpx.HTTPError as exc:
        return {"up": False, "error": type(exc).__name__}


async def probe_tcp(address: str, port: int) -> dict:
    start = time.perf_counter()
    try:
        _, writer = await asyncio.wait_for(asyncio.open_connection(address, port), timeout=3)
        writer.close()
        return {"up": True, "latency": round((time.perf_counter() - start) * 1000)}
    except (OSError, asyncio.TimeoutError) as exc:
        return {"up": False, "error": type(exc).__name__}


def collect_nfs() -> dict:
    exports = []
    for line in read_text(host_path("/etc/exports")).splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            path, *clients = line.split()
            exports.append({"path": path, "clients": [c.split("(")[0] for c in clients]})
    clients = []
    clients_dir = Path(host_path("/proc/fs/nfsd/clients"))
    if clients_dir.is_dir():
        for info in clients_dir.glob("*/info"):
            addr = re.search(r'^address:\s*"?([^"\n]+)', read_text(str(info)), re.M)
            if addr:
                clients.append(addr.group(1).rsplit(":", 1)[0])
    return {"exports": exports, "clients": sorted(set(clients))}


async def probe_loop():
    async with httpx.AsyncClient(timeout=4, verify=False, follow_redirects=True) as client:
        while True:
            cfg = load_config()
            services = cfg.get("services", [])
            nodes = cfg.get("nodes", [])

            async def svc(s):
                res = await probe_http(client, s["url"]) if s.get("url") else {"up": None}
                return {"name": s["name"], "group": s.get("group", ""), "container": s.get("container"),
                        "url": s.get("url", ""), **res}

            async def node(n):
                return {"name": n["name"], "address": n["address"], **await probe_tcp(n["address"], n.get("port", 22))}

            state["services"] = list(await asyncio.gather(*(svc(s) for s in services)))
            state["nodes"] = list(await asyncio.gather(*(node(n) for n in nodes)))
            state["nfs"] = await asyncio.to_thread(collect_nfs)
            state["meta"] = collect_meta(cfg)
            await asyncio.sleep(PROBE_INTERVAL)


# --------------------------------------------------------------------- alerts

def build_alerts() -> list:
    alerts = []
    sysinfo = state["system"]
    if sysinfo:
        cpu = sysinfo["cpu"]
        if cpu["percent"] >= 90:
            alerts.append(("critical", f"CPU load at {cpu['percent']:.0f}%"))
        if cpu["temp"] and cpu["temp"] >= 80:
            alerts.append(("critical" if cpu["temp"] >= 90 else "warning", f"CPU temperature {cpu['temp']:.0f}°C"))
        if sysinfo["memory"]["percent"] >= 90:
            alerts.append(("warning", f"Memory at {sysinfo['memory']['percent']:.0f}%"))
        for d in sysinfo["disks"]:
            if not d["mounted"]:
                alerts.append(("critical", f"{d['name']} drive not mounted ({d['path']})"))
            elif d.get("percent", 0) >= 90:
                alerts.append(("warning", f"{d['name']} at {d['percent']:.0f}% capacity"))
    docker = state["docker"]
    if not docker.get("available"):
        alerts.append(("warning", "Docker API unreachable"))
    for c in docker.get("containers", []):
        if c["state"] in ("exited", "dead", "restarting"):
            alerts.append(("critical", f"Container {c['name']} is {c['state']}"))
        elif c.get("health") == "unhealthy":
            alerts.append(("warning", f"Container {c['name']} is unhealthy"))
    for s in state["services"]:
        if s.get("up") is False:
            alerts.append(("critical", f"{s['name']} not responding"))
    for n in state["nodes"]:
        if not n.get("up"):
            alerts.append(("critical", f"Node {n['name']} unreachable"))
    return [{"level": lvl, "message": msg} for lvl, msg in alerts]


# ------------------------------------------------------------------------ app

@asynccontextmanager
async def lifespan(_: FastAPI):
    state["meta"] = collect_meta(load_config())
    tasks = [asyncio.create_task(fn()) for fn in (system_loop, docker_loop, probe_loop)]
    yield
    for t in tasks:
        t.cancel()


app = FastAPI(title="SELENE HUD", lifespan=lifespan)


@app.get("/api/state")
async def get_state():
    return {
        "time": time.time(),
        "meta": state["meta"],
        "system": state["system"],
        "docker": state["docker"],
        "services": state["services"],
        "nodes": state["nodes"],
        "nfs": state["nfs"],
        "alerts": build_alerts(),
        "history": {k: list(v) for k, v in state["history"].items()},
    }


@app.get("/api/health")
async def health():
    return {"ok": True}


if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
