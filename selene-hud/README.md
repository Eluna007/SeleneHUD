# SELENE HUD

A Jarvis-style, purple & burgundy dashboard for the homelab. One small Docker
container on Selene collects telemetry and serves a full-screen HUD that works
on a wall screen and on a phone.

```
 Browser (kiosk screen / phone)
        │  GET /api/state every 2s
        ▼
 selene-hud container (FastAPI, :8420, host network)
   ├─ host metrics   psutil → CPU, per-core, RAM, swap, temps, net, disk I/O, top processes
   ├─ storage        /hostfs → disk usage, mount check for MUSIC / PHOTOS drives
   ├─ docker         /var/run/docker.sock (GET only) → container state, health, CPU, RAM
   ├─ services       HTTP probe per service → up/down + latency
   ├─ nodes          TCP probe → CRATERPI etc.
   └─ NFS            /etc/exports + active nfsd clients
```

Everything is **read-only**. The HUD never starts, stops or changes anything.

## Deploy on Selene

```bash
# 1. get the code onto Selene
git clone https://github.com/eluna007/homelabbackups.git ~/homelabbackups
cd ~/homelabbackups/selene-hud

# 2. edit config/hud.yaml: drive mount paths, craterpi IP, service ports/URLs
nano config/hud.yaml

# 3. build + start
docker compose up -d --build

# 4. allow LAN access through ufw
sudo ufw allow from 192.168.68.0/24 to any port 8420 proto tcp
```

Open `http://192.168.68.105:8420` from any device on the LAN.

After editing `config/hud.yaml`, the changes are picked up within ~15 s. No restart is needed.
After changing frontend/backend code, run `docker compose up -d --build`.

### Finding the right values for `hud.yaml`

```bash
lsblk -o NAME,SIZE,MOUNTPOINT          # where the music / photos drives are mounted
docker ps --format '{{.Names}}\t{{.Ports}}'   # container names + ports
cat /etc/exports                        # NFS shares (shown automatically)
```

## Useful URL flags

| URL | Effect |
|---|---|
| `/?noboot` | Skip the boot animation |
| `/?demo` | Fake data. Preview the HUD without the backend |

## On the phone

Open the URL in the browser, then **Add to Home Screen**. It launches full-screen
like an app. Remote access (when away from home) is the next step in the roadmap.

## Roadmap

- [x] **Phase 1**: core HUD: host, storage, Docker, service health, nodes, NFS, alerts
- [ ] **Phase 2**: per-app panels via APIs: Pi-hole (queries/blocked), Navidrome
      (library, now playing), Immich (photos/videos/storage), Lidarr (queue, missing),
      slskd (transfers), Seanime
- [ ] **Phase 3**: kiosk mode: Selene boots straight into the HUD on an attached screen
- [ ] **Phase 4**: remote access from the phone (Tailscale), and an agent on craterpi for its stats

## Security notes

- The Docker socket is mounted so the HUD can read container stats. Only GET
  requests are made, but socket access is powerful. Don't expose port 8420 to
  the internet. Use the VPN (Phase 4) for remote access.
- The host root filesystem is mounted read-only at `/hostfs`.
