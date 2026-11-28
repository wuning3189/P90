(function () {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const TZ_KEY = "tools:timestamp:tz";
  const WEEKDAYS = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
  const ZONES = [
    ["local", `本地时区（${LOCAL_TZ}）`],
    ["UTC", "UTC"],
    ["Asia/Shanghai", "中国 · 上海"],
    ["Asia/Hong_Kong", "中国 · 香港"],
    ["Asia/Tokyo", "日本 · 东京"],
    ["Asia/Seoul", "韩国 · 首尔"],
    ["Asia/Singapore", "新加坡"],
    ["Asia/Kolkata", "印度 · 加尔各答"],
    ["Asia/Dubai", "阿联酋 · 迪拜"],
    ["Europe/Moscow", "俄罗斯 · 莫斯科"],
    ["Europe/London", "英国 · 伦敦"],
    ["Europe/Paris", "法国 · 巴黎"],
    ["America/New_York", "美国 · 纽约"],
    ["America/Chicago", "美国 · 芝加哥"],
    ["America/Los_Angeles", "美国 · 洛杉矶"],
    ["Australia/Sydney", "澳大利亚 · 悉尼"],
    ["Pacific/Auckland", "新西兰 · 奥克兰"],
  ];

  const ui = {
    tz: $("#tz"), pause: $("#pauseBtn"),
    nowSec: $("#nowSec"), nowMs: $("#nowMs"), nowText: $("#nowText"),
    tsIn: $("#tsIn"), tsUnit: $("#tsUnit"), tsMsg: $("#tsMsg"), tsOut: $("#tsOut"),
    dtIn: $("#dtIn"), dtPick: $("#dtPick"), dtMsg: $("#dtMsg"), dtOut: $("#dtOut"),
    batchIn: $("#batchIn"), batchOut: $("#batchOut"), batchUnit: $("#batchUnit"),
    diffA: $("#diffA"), diffB: $("#diffB"), diffMsg: $("#diffMsg"), diffOut: $("#diffOut"),
    calcBase: $("#calcBase"), calcSign: $("#calcSign"), calcAmount: $("#calcAmount"),
    calcUnit: $("#calcUnit"), calcMsg: $("#calcMsg"), calcOut: $("#calcOut"),
    quick: $("#quickOut"),
  };

  // ---------- 时区计算 ----------
  const formatters = new Map();

  function zoneName() {
    return ui.tz.value === "local" ? LOCAL_TZ : ui.tz.value;
  }

  function formatter(tz) {
    if (!formatters.has(tz)) {
      formatters.set(tz, new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
      }));
    }
    return formatters.get(tz);
  }

  /** 把毫秒时间戳拆成某时区的墙上时间。 */
  function wallParts(ms, tz) {
    const o = {};
    for (const part of formatter(tz).formatToParts(new Date(ms))) o[part.type] = part.value;
    return {
      y: Number(o.year), mo: Number(o.month), d: Number(o.day),
      h: Number(o.hour) % 24, mi: Number(o.minute), s: Number(o.second),
      ms: ((ms % 1000) + 1000) % 1000,
    };
  }

  function offsetMs(ms, tz) {
    const p = wallParts(ms, tz);
    return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
  }

  /** 把某时区的墙上时间换成毫秒时间戳。 */
  function wallToEpoch(y, mo, d, h, mi, s, ms, tz) {
    const guess = Date.UTC(y, mo - 1, d, h, mi, s, ms);
    const first = guess - offsetMs(guess, tz);
    return guess - offsetMs(first, tz);
  }

  const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, "0");

  function offsetLabel(ms, tz) {
    const minutes = Math.round(offsetMs(ms, tz) / 60000);
    const sign = minutes < 0 ? "-" : "+";
    return `${sign}${pad(Math.floor(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`;
  }

  function fmtWall(ms, tz, withMs) {
    const p = wallParts(ms, tz);
    const base = `${pad(p.y, 4)}-${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`;
    return withMs ? `${base}.${pad(p.ms, 3)}` : base;
  }

  function fmtIsoOffset(ms, tz) {
    return `${fmtWall(ms, tz, true).replace(" ", "T")}${offsetLabel(ms, tz)}`;
  }

  function isoWeek(y, m, d) {
    const t = new Date(Date.UTC(y, m - 1, d));
    t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7) + 3);
    const first = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
    const week = 1 + Math.round(((t - first) / 864e5 - 3 + ((first.getUTCDay() + 6) % 7)) / 7);
    return { year: t.getUTCFullYear(), week };
  }

  const rtf = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });

  function relative(ms) {
    const diff = ms - Date.now();
    const abs = Math.abs(diff);
    if (abs < 1000) return "现在";
    const steps = [[60e3, 1e3, "second"], [3600e3, 60e3, "minute"], [864e5, 3600e3, "hour"],
    [30 * 864e5, 864e5, "day"], [365 * 864e5, 30 * 864e5, "month"], [Infinity, 365 * 864e5, "year"]];
    for (const [limit, unit, name] of steps) {
      if (abs < limit) return rtf.format(Math.round(diff / unit), name);
    }
    return "";
  }

  // ---------- 解析 ----------
  const MAX_MS = 8.64e15;

  function parseTimestamp(text, unit) {
    const str = text.trim();
    if (!/^-?\d+(\.\d+)?$/.test(str)) throw new Error("时间戳只能包含数字（可带负号和小数点）");
    const num = Number(str);
    let used = unit;
    if (unit === "auto") {
      const abs = Math.abs(num);
      used = abs < 1e11 ? "s" : abs < 1e14 ? "ms" : abs < 1e17 ? "us" : "ns";
    }
    let ms;
    if (used === "s") ms = Math.round(num * 1000);
    else if (used === "ms") ms = Math.round(num);
    else if (used === "us") ms = Math.trunc(num / 1000);
    else ms = /^-?\d+$/.test(str) ? Number(BigInt(str) / 1000000n) : Math.trunc(num / 1e6);
    if (!Number.isFinite(ms) || Math.abs(ms) > MAX_MS) throw new Error("时间戳超出可表示范围");
    return { ms, unit: used };
  }

  const UNIT_NAME = { s: "秒", ms: "毫秒", us: "微秒", ns: "纳秒" };

  function parseDate(text, tz) {
    const str = text.trim();
    if (!str) throw new Error("请输入日期时间");

    if (/\d[T\s]\d{1,2}:\d{2}.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(str) || /^\d{4}-\d{2}-\d{2}T.*Z$/i.test(str)) {
      const fixed = str.replace(/\s+/, "T").replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
      const ms = Date.parse(fixed);
      if (Number.isNaN(ms)) throw new Error("无法识别的日期格式");
      return ms;
    }

    let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?$/.exec(str);
    if (!m) {
      const c = /^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})(\d{2}))?$/.exec(str);
      if (c) m = [c[0], c[1], c[2], c[3], c[4], c[5], c[6], undefined];
    }
    if (!m) throw new Error("无法识别的日期格式，请使用 YYYY-MM-DD HH:mm:ss");

    const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4] || 0, m[5] || 0, m[6] || 0].map(Number);
    const frac = m[7] ? Number(m[7].padEnd(3, "0").slice(0, 3)) : 0;
    const check = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) {
      throw new Error("日期或时间不存在");
    }
    return wallToEpoch(y, mo, d, h, mi, s, frac, tz);
  }

  /** 数字按时间戳（自动单位）解析，其余按日期解析。 */
  function parseAny(text, tz) {
    const str = text.trim();
    if (/^-?\d+(\.\d+)?$/.test(str) && !/^\d{8}$|^\d{14}$/.test(str)) return parseTimestamp(str, "auto").ms;
    return parseDate(str, tz);
  }

  // ---------- 渲染工具 ----------
  function kvRows(container, rows) {
    container.replaceChildren(...rows.map(([key, value, highlighted]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `kv${highlighted ? " hl" : ""}`;
      button.title = "点击复制";
      const k = document.createElement("span");
      k.className = "k";
      k.textContent = key;
      const v = document.createElement("span");
      v.className = "v";
      v.textContent = value;
      button.append(k, v);
      button.addEventListener("click", () => window.copyText(value, `已复制：${key}`));
      return button;
    }));
  }

  function setMsg(node, text, ok) {
    node.textContent = text || "";
    node.classList.toggle("ok", Boolean(ok));
  }

  function epochRows(ms, tz) {
    const p = wallParts(ms, tz);
    const week = isoWeek(p.y, p.mo, p.d);
    const dayOfYear = Math.floor((Date.UTC(p.y, p.mo - 1, p.d) - Date.UTC(p.y, 0, 0)) / 864e5);
    const weekday = WEEKDAYS[new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay()];
    const rows = [
      [`${zoneName()} (UTC${offsetLabel(ms, tz)})`, fmtWall(ms, tz, true), true],
      ["UTC", fmtWall(ms, "UTC", true)],
    ];
    if (zoneName() !== LOCAL_TZ) rows.push([`本地 (UTC${offsetLabel(ms, LOCAL_TZ)})`, fmtWall(ms, LOCAL_TZ, true)]);
    rows.push(
      ["ISO 8601（所选时区）", fmtIsoOffset(ms, tz)],
      ["ISO 8601（UTC）", new Date(ms).toISOString()],
      ["RFC 7231", new Date(ms).toUTCString()],
      ["星期 / 年内第几天", `${weekday} · 第 ${dayOfYear} 天`],
      ["ISO 周", `${week.year} 年第 ${week.week} 周`],
      ["相对现在", relative(ms)],
      ["秒", String(Math.floor(ms / 1000))],
      ["毫秒", String(ms)],
      ["微秒", String(ms * 1000)],
      ["纳秒", (BigInt(ms) * 1000000n).toString()],
    );
    return rows;
  }

  // ---------- 各面板 ----------
  function renderTs() {
    const text = ui.tsIn.value;
    ui.tsIn.classList.remove("bad");
    if (!text.trim()) { ui.tsOut.replaceChildren(); return setMsg(ui.tsMsg, ""); }
    try {
      const { ms, unit } = parseTimestamp(text, ui.tsUnit.value);
      kvRows(ui.tsOut, epochRows(ms, zoneName()));
      setMsg(ui.tsMsg, ui.tsUnit.value === "auto" ? `按${UNIT_NAME[unit]}识别` : "", true);
    } catch (error) {
      ui.tsOut.replaceChildren();
      ui.tsIn.classList.add("bad");
      setMsg(ui.tsMsg, error.message);
    }
  }

  function renderDt() {
    const text = ui.dtIn.value;
    ui.dtIn.classList.remove("bad");
    if (!text.trim()) { ui.dtOut.replaceChildren(); return setMsg(ui.dtMsg, ""); }
    try {
      const ms = parseDate(text, zoneName());
      kvRows(ui.dtOut, [
        ["秒", String(Math.floor(ms / 1000)), true],
        ["毫秒", String(ms), true],
        ["微秒", String(ms * 1000)],
        ["纳秒", (BigInt(ms) * 1000000n).toString()],
        ["ISO 8601（UTC）", new Date(ms).toISOString()],
        ["所选时区", `${fmtWall(ms, zoneName(), true)} (UTC${offsetLabel(ms, zoneName())})`],
      ]);
      setMsg(ui.dtMsg, "");
    } catch (error) {
      ui.dtOut.replaceChildren();
      ui.dtIn.classList.add("bad");
      setMsg(ui.dtMsg, error.message);
    }
  }

  function renderBatch() {
    const tz = zoneName();
    const lines = ui.batchIn.value.split(/\r?\n/);
    const asSeconds = ui.batchUnit.value === "s";
    ui.batchOut.value = lines.map((line) => {
      if (!line.trim()) return "";
      try {
        const isTs = /^-?\d+(\.\d+)?$/.test(line.trim()) && !/^\d{8}$|^\d{14}$/.test(line.trim());
        const ms = parseAny(line, tz);
        if (isTs) return fmtWall(ms, tz, ms % 1000 !== 0);
        return String(asSeconds ? Math.floor(ms / 1000) : ms);
      } catch (error) {
        return `错误：${error.message}`;
      }
    }).join("\n");
  }

  function durationText(diff) {
    let rest = Math.abs(diff);
    const days = Math.floor(rest / 864e5); rest -= days * 864e5;
    const hours = Math.floor(rest / 36e5); rest -= hours * 36e5;
    const minutes = Math.floor(rest / 6e4); rest -= minutes * 6e4;
    const seconds = Math.floor(rest / 1000);
    const millis = rest - seconds * 1000;
    return `${days} 天 ${hours} 小时 ${minutes} 分 ${seconds} 秒 ${millis} 毫秒`;
  }

  function renderDiff() {
    ui.diffMsg.textContent = "";
    if (!ui.diffA.value.trim() || !ui.diffB.value.trim()) return ui.diffOut.replaceChildren();
    try {
      const a = parseAny(ui.diffA.value, zoneName());
      const b = parseAny(ui.diffB.value, zoneName());
      const diff = b - a;
      const f = (n) => (Math.abs(n) % 1 === 0 ? String(n) : n.toFixed(3).replace(/\.?0+$/, ""));
      kvRows(ui.diffOut, [
        ["相差", `${diff < 0 ? "结束早于开始 " : ""}${durationText(diff)}`, true],
        ["总毫秒", String(diff)],
        ["总秒数", f(diff / 1000)],
        ["总分钟", f(diff / 6e4)],
        ["总小时", f(diff / 36e5)],
        ["总天数", f(diff / 864e5)],
      ]);
    } catch (error) {
      ui.diffOut.replaceChildren();
      setMsg(ui.diffMsg, error.message);
    }
  }

  function renderCalc() {
    ui.calcMsg.textContent = "";
    const tz = zoneName();
    try {
      const base = ui.calcBase.value.trim() ? parseAny(ui.calcBase.value, tz) : Date.now();
      const amount = Number(ui.calcAmount.value);
      if (!Number.isInteger(amount)) throw new Error("数量需要是整数");
      const n = amount * Number(ui.calcSign.value);
      const unit = ui.calcUnit.value;
      let result;
      if (unit === "s" || unit === "m" || unit === "h") {
        result = base + n * { s: 1e3, m: 6e4, h: 36e5 }[unit];
      } else {
        const p = wallParts(base, tz);
        const t = new Date(Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s));
        if (unit === "d") t.setUTCDate(t.getUTCDate() + n);
        else if (unit === "w") t.setUTCDate(t.getUTCDate() + n * 7);
        else if (unit === "mo") {
          const day = t.getUTCDate();
          t.setUTCDate(1);
          t.setUTCMonth(t.getUTCMonth() + n);
          const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
          t.setUTCDate(Math.min(day, last));
        } else {
          const day = t.getUTCDate();
          t.setUTCDate(1);
          t.setUTCFullYear(t.getUTCFullYear() + n);
          const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
          t.setUTCDate(Math.min(day, last));
        }
        result = wallToEpoch(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate(), t.getUTCHours(), t.getUTCMinutes(), t.getUTCSeconds(), p.ms, tz);
      }
      if (Math.abs(result) > MAX_MS) throw new Error("结果超出可表示范围");
      kvRows(ui.calcOut, [
        ["基准", fmtWall(base, tz, true)],
        ["结果", fmtWall(result, tz, true), true],
        ["秒", String(Math.floor(result / 1000))],
        ["毫秒", String(result)],
      ]);
    } catch (error) {
      ui.calcOut.replaceChildren();
      setMsg(ui.calcMsg, error.message);
    }
  }

  let quickDay = "";
  function renderQuick(force) {
    const tz = zoneName();
    const now = Date.now();
    const p = wallParts(now, tz);
    const key = `${tz}|${p.y}-${p.mo}-${p.d}`;
    if (!force && key === quickDay) return;
    quickDay = key;

    const dayStart = (y, mo, d) => wallToEpoch(y, mo, d, 0, 0, 0, 0, tz);
    const today = dayStart(p.y, p.mo, p.d);
    const shift = (days) => {
      const t = new Date(Date.UTC(p.y, p.mo - 1, p.d + days));
      return dayStart(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
    };
    const weekday = (new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay() + 6) % 7;
    const points = [
      ["今天 00:00:00", today],
      ["今天 23:59:59", shift(1) - 1000],
      ["昨天 00:00:00", shift(-1)],
      ["明天 00:00:00", shift(1)],
      ["本周一 00:00:00", shift(-weekday)],
      ["本月 1 日 00:00:00", dayStart(p.y, p.mo, 1)],
      ["下月 1 日 00:00:00", dayStart(p.mo === 12 ? p.y + 1 : p.y, p.mo === 12 ? 1 : p.mo + 1, 1)],
      ["本年 1 月 1 日 00:00:00", dayStart(p.y, 1, 1)],
    ];

    ui.quick.replaceChildren(...points.map(([label, ms]) => {
      const item = document.createElement("div");
      item.className = "qitem";
      const title = document.createElement("div");
      title.className = "qt";
      title.textContent = label;
      const date = document.createElement("div");
      date.className = "qd";
      date.textContent = fmtWall(ms, tz, false);
      const row = document.createElement("div");
      row.className = "qv";
      for (const [text, value] of [["秒 " + Math.floor(ms / 1000), String(Math.floor(ms / 1000))], ["毫秒 " + ms, String(ms)]]) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = text;
        button.title = "点击复制";
        button.addEventListener("click", () => window.copyText(value));
        row.append(button);
      }
      item.append(title, date, row);
      return item;
    }));
  }

  // ---------- 当前时间 ----------
  let paused = false;
  function tick() {
    if (paused) return;
    const now = Date.now();
    ui.nowSec.textContent = String(Math.floor(now / 1000));
    ui.nowMs.textContent = String(now);
    ui.nowText.textContent = fmtWall(now, zoneName(), true);
    renderQuick(false);
  }

  function toLocalInputValue(ms, tz) {
    return fmtWall(ms, tz, false).replace(" ", "T");
  }

  function refreshAll() {
    renderTs();
    renderDt();
    renderBatch();
    renderDiff();
    renderCalc();
    renderQuick(true);
    tick();
  }

  // ---------- 事件 ----------
  for (const [value, label] of ZONES) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    ui.tz.append(option);
  }
  try {
    const saved = localStorage.getItem(TZ_KEY);
    if (saved && ZONES.some(([value]) => value === saved)) ui.tz.value = saved;
  } catch (_) { /* 忽略 */ }

  ui.tz.addEventListener("change", () => {
    try { localStorage.setItem(TZ_KEY, ui.tz.value); } catch (_) { /* 忽略 */ }
    refreshAll();
  });

  ui.pause.addEventListener("click", () => {
    paused = !paused;
    ui.pause.textContent = paused ? "继续" : "暂停";
    ui.pause.classList.toggle("active", paused);
    tick();
  });

  for (const node of [ui.nowSec, ui.nowMs, ui.nowText]) {
    node.addEventListener("click", () => window.copyText(node.textContent));
  }

  ui.tsIn.addEventListener("input", renderTs);
  ui.tsUnit.addEventListener("change", renderTs);
  $("#tsNow").addEventListener("click", () => {
    ui.tsIn.value = ui.tsUnit.value === "s" ? String(Math.floor(Date.now() / 1000)) : String(Date.now());
    renderTs();
  });

  ui.dtIn.addEventListener("input", renderDt);
  ui.dtPick.addEventListener("change", () => {
    if (!ui.dtPick.value) return;
    ui.dtIn.value = ui.dtPick.value.replace("T", " ").replace(/^(\S+ \d{2}:\d{2})$/, "$1:00");
    renderDt();
  });
  $("#dtNow").addEventListener("click", () => {
    ui.dtIn.value = fmtWall(Date.now(), zoneName(), false);
    ui.dtPick.value = toLocalInputValue(Date.now(), zoneName());
    renderDt();
  });

  ui.batchIn.addEventListener("input", renderBatch);
  ui.batchUnit.addEventListener("change", renderBatch);
  $("#batchCopy").addEventListener("click", () => {
    if (!ui.batchOut.value.trim()) return window.toast("没有可复制的结果", true);
    window.copyText(ui.batchOut.value, "已复制批量结果");
  });

  ui.diffA.addEventListener("input", renderDiff);
  ui.diffB.addEventListener("input", renderDiff);
  $("#diffNow").addEventListener("click", () => {
    ui.diffB.value = String(Date.now());
    renderDiff();
  });

  for (const node of [ui.calcBase, ui.calcSign, ui.calcAmount, ui.calcUnit]) {
    node.addEventListener("input", renderCalc);
  }

  // ---------- 初始化 ----------
  const initial = Date.now();
  ui.tsIn.value = String(Math.floor(initial / 1000));
  ui.dtIn.value = fmtWall(initial, zoneName(), false);
  ui.dtPick.value = toLocalInputValue(initial, zoneName());
  ui.batchIn.value = `${Math.floor(initial / 1000)}\n${initial}\n${fmtWall(initial, zoneName(), false)}`;
  ui.diffA.value = String(Math.floor(initial / 1000));
  refreshAll();
  setInterval(tick, 100);
})();
