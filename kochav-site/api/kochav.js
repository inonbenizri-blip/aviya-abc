// שרת לתחרות "הכוכב הבא של משפחת חזן"
// שומר את הנתונים ב-Upstash Redis (מחובר דרך Vercel > Storage).
// כל הנתונים יושבים ב-hash אחד: כל שדה הוא נתיב (למשל votes/f3/f7) והערך שלו JSON.

const ADMIN_PIN = process.env.KOCHAV_ADMIN_PIN || "2026";
const HASH = "kochav";
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

async function redis(cmds) {
  const r = await fetch(URL_ + "/pipeline", {
    method: "POST",
    headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(cmds)
  });
  if (!r.ok) throw new Error("redis " + r.status);
  const out = await r.json();
  return out.map(x => { if (x.error) throw new Error(x.error); return x.result; });
}

async function readTree() {
  const [flat] = await redis([["HGETALL", HASH]]);
  const tree = {};
  for (let i = 0; i < flat.length; i += 2) {
    const parts = flat[i].split("/");
    let o = tree;
    for (let j = 0; j < parts.length - 1; j++) o = o[parts[j]] = (o[parts[j]] && typeof o[parts[j]] === "object") ? o[parts[j]] : {};
    try { o[parts[parts.length - 1]] = JSON.parse(flat[i + 1]); } catch (e) {}
  }
  return tree;
}

function flatten(path, v, out) {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const k of Object.keys(v)) flatten(path + "/" + k, v[k], out);
  } else if (v !== null && v !== undefined) out.push(path, JSON.stringify(v));
  return out;
}

const cleanPath = p => String(p || "").split("/").filter(s => /^[A-Za-z0-9_-]{1,40}$/.test(s)).join("/");

async function removePath(path) {
  const [keys] = await redis([["HKEYS", HASH]]);
  const del = keys.filter(k => k === path || k.startsWith(path + "/"));
  if (del.length) await redis([["HDEL", HASH, ...del]]);
}

async function setPath(path, value) {
  await removePath(path);
  const pairs = flatten(path, value, []);
  if (pairs.length) await redis([["HSET", HASH, ...pairs]]);
}

async function updatePath(path, value) {
  const cmds = [];
  for (const k of Object.keys(value || {})) {
    const sub = cleanPath(path + "/" + k);
    if (value[k] === null) { await removePath(sub); continue; }
    if (value[k] && typeof value[k] === "object") await removePath(sub);
    const pairs = flatten(sub, value[k], []);
    if (pairs.length) cmds.push(["HSET", HASH, ...pairs]);
  }
  if (cmds.length) await redis(cmds);
}

function ranking(tree) {
  const fams = tree.families || {};
  return Object.keys(fams).map(id => {
    const v = Object.values((tree.votes || {})[id] || {}).map(Number).filter(Boolean);
    const total = v.reduce((a, b) => a + b, 0);
    return { id, name: fams[id].name, total, count: v.length, avg: v.length ? total / v.length : 0 };
  }).filter(x => x.count).sort((a, b) => b.avg - a.avg);
}

// מה שכולם רואים: בלי קודים ובלי ציונים
function publicView(tree, me) {
  const fams = {};
  for (const [id, f] of Object.entries(tree.families || {})) fams[id] = { name: f.name, song: f.song || "", order: f.order };
  const votes = {};
  for (const [pid, vs] of Object.entries(tree.votes || {})) {
    votes[pid] = {};
    for (const vid of Object.keys(vs)) votes[pid][vid] = me && vid === me ? Number(vs[vid]) : true;
  }
  const state = tree.state || { phase: "lobby", current: null };
  const out = { families: fams, state, done: tree.done || {}, votes };
  if (state.phase === "reveal") {
    const r = ranking(tree);
    out.winners = r.length ? r.filter(x => Math.abs(x.avg - r[0].avg) < 1e-9).map(x => x.name) : [];
  }
  return out;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!URL_ || !TOKEN) return res.status(500).json({ error: "no-db" });
  try {
    if (req.method === "GET") {
      const tree = await readTree();
      const pin = req.headers["x-admin-pin"];
      if (pin && pin === ADMIN_PIN) return res.json({ admin: true, ...tree });
      const fam = req.headers["x-family"], code = req.headers["x-code"];
      const me = fam && tree.families && tree.families[fam] && String(tree.families[fam].code) === String(code) ? fam : null;
      return res.json(publicView(tree, me));
    }
    const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const tree = await readTree();
    const fams = tree.families || {};

    if (b.action === "login") {
      const f = fams[b.fam];
      return res.json({ ok: !!(f && String(f.code) === String(b.code)) });
    }

    if (b.action === "vote") {
      const f = fams[b.fam]; const st = tree.state || {};
      if (!f || String(f.code) !== String(b.code)) return res.status(403).json({ error: "קוד שגוי" });
      if (st.phase !== "voting" || st.current !== b.perf) return res.status(409).json({ error: "ההצבעה סגורה" });
      if (b.fam === b.perf) return res.status(400).json({ error: "אי אפשר להצביע לעצמכם" });
      const score = Number(b.score);
      if (![1, 3, 5].includes(score)) return res.status(400).json({ error: "ציון לא תקין" });
      await redis([["HSET", HASH, `votes/${cleanPath(b.perf)}/${cleanPath(b.fam)}`, String(score)]]);
      return res.json({ ok: true });
    }

    if (b.action === "admin") {
      if (b.pin !== ADMIN_PIN) return res.status(403).json({ error: "קוד מנהל שגוי" });
      const path = cleanPath(b.path);
      if (!path) return res.status(400).json({ error: "נתיב חסר" });
      if (b.op === "set") await setPath(path, b.value);
      else if (b.op === "update") await updatePath(path, b.value);
      else if (b.op === "remove") await removePath(path);
      else return res.status(400).json({ error: "פעולה לא מוכרת" });
      return res.json({ ok: true });
    }
    return res.status(400).json({ error: "בקשה לא מוכרת" });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
};
