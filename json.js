(function () {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const ui = {
    input: $("#input"), outText: $("#outText"), outTree: $("#outTree"),
    banner: $("#banner"), stats: $("#stats"), inCount: $("#inCount"),
    indent: $("#indent"), sort: $("#optSort"), loose: $("#optLoose"),
    unwrap: $("#optUnwrap"), ascii: $("#optAscii"), paste: $("#optPaste"),
    tabText: $("#tabText"), tabTree: $("#tabTree"), treeTools: $("#treeTools"),
    query: $("#query"), queryOut: $("#queryOut"),
  };

  const STORE_KEY = "tools:json:input";
  const MAX_STORE = 500 * 1024;
  const TREE_NODE_LIMIT = 20000;
  const CHUNK = 500;
  const HIGHLIGHT_LIMIT = 1500000;

  const SAMPLE = `{
  // 示例：含注释、单引号、末尾逗号，开启「宽松语法修复」后可解析
  name: '工具集',
  version: 1.2,
  tags: ['json', "time", 'markdown',],
  author: { id: 10086, active: true, email: null },
  items: [
    { id: 1, title: "格式化", score: 4.5 },
    { id: 2, title: "时间戳", score: 4.8 },
  ],
  payload: "{\\"nested\\":true,\\"list\\":[1,2,3]}",
}`;

  const state = { value: undefined, hasValue: false, text: "", view: "text", treeDirty: true };

  // ---------- 工具函数 ----------
  function escapeHtml(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function byteSize(text) {
    return new TextEncoder().encode(text).length;
  }

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  }

  function highlight(json) {
    const pattern = /("(?:\\u[\da-fA-F]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
    return escapeHtml(json).replace(pattern, (match, _all, colon) => {
      let cls = "tk-num";
      if (match.startsWith('"')) cls = colon ? "tk-key" : "tk-str";
      else if (match === "true" || match === "false") cls = "tk-bool";
      else if (match === "null") cls = "tk-null";
      return `<span class="${cls}">${match}</span>`;
    });
  }

  function sortDeep(value) {
    if (Array.isArray(value)) return value.map(sortDeep);
    if (value && typeof value === "object") {
      const out = {};
      for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key]);
      return out;
    }
    return value;
  }

  function measure(value) {
    let nodes = 0, keys = 0, maxDepth = 0;
    const stack = [[value, 1]];
    while (stack.length) {
      const [item, depth] = stack.pop();
      nodes++;
      maxDepth = Math.max(maxDepth, depth);
      if (item && typeof item === "object") {
        const children = Array.isArray(item) ? item : Object.values(item);
        if (!Array.isArray(item)) keys += children.length;
        for (const child of children) stack.push([child, depth + 1]);
      }
    }
    return { nodes, keys, maxDepth };
  }

  function typeName(value) {
    if (value === null) return "null";
    if (Array.isArray(value)) return "数组";
    if (typeof value === "object") return "对象";
    return { string: "字符串", number: "数字", boolean: "布尔" }[typeof value] || typeof value;
  }

  // ---------- 宽松语法修复 ----------
  function repair(src) {
    let out = "";
    let i = 0;
    const n = src.length;
    while (i < n) {
      const c = src[i];
      if (c === '"') {
        let j = i + 1;
        while (j < n && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
        out += src.slice(i, j + 1);
        i = j + 1;
      } else if (c === "'") {
        let j = i + 1;
        let body = "";
        while (j < n && src[j] !== "'") {
          if (src[j] === "\\" && src[j + 1] === "'") { body += "'"; j += 2; }
          else if (src[j] === "\\") { body += src[j] + (src[j + 1] || ""); j += 2; }
          else { body += src[j] === '"' ? '\\"' : src[j]; j++; }
        }
        out += `"${body}"`;
        i = j + 1;
      } else if (c === "/" && src[i + 1] === "/") {
        while (i < n && src[i] !== "\n") i++;
      } else if (c === "/" && src[i + 1] === "*") {
        const end = src.indexOf("*/", i + 2);
        i = end < 0 ? n : end + 2;
      } else if (c === ",") {
        let j = i + 1;
        while (j < n && /\s/.test(src[j])) j++;
        if (src[j] === "}" || src[j] === "]") i++;
        else { out += c; i++; }
      } else if (/[A-Za-z_$]/.test(c)) {
        let j = i;
        while (j < n && /[\w$]/.test(src[j])) j++;
        const word = src.slice(i, j);
        let k = j;
        while (k < n && /\s/.test(src[k])) k++;
        out += src[k] === ":" ? `"${word}"` : word;
        i = j;
      } else {
        out += c;
        i++;
      }
    }
    return out;
  }

  // ---------- 错误定位 ----------
  function locate(error, text) {
    const message = String(error && error.message);
    const lc = /line (\d+) column (\d+)/i.exec(message);
    const pos = /position (\d+)/i.exec(message);
    let offset = pos ? Number(pos[1]) : null;
    let line, col;
    if (lc) {
      line = Number(lc[1]);
      col = Number(lc[2]);
      if (offset === null) {
        const lines = text.split("\n");
        offset = lines.slice(0, line - 1).reduce((sum, l) => sum + l.length + 1, 0) + col - 1;
      }
    } else if (offset !== null) {
      const before = text.slice(0, offset).split("\n");
      line = before.length;
      col = before[before.length - 1].length + 1;
    }
    return { message, offset, line, col };
  }

  function setBanner(kind, message) {
    ui.banner.hidden = !message;
    ui.banner.className = `banner ${kind || ""}`;
    ui.banner.textContent = message || "";
  }

  function fail(error, text) {
    const info = locate(error, text);
    let message = `JSON 无效：${info.message}`;
    if (info.line) {
      const lineText = text.split("\n")[info.line - 1] || "";
      const start = Math.max(0, info.col - 30);
      message = `JSON 无效：第 ${info.line} 行，第 ${info.col} 列\n${lineText.slice(start, start + 80)}\n${" ".repeat(Math.max(0, info.col - 1 - start))}^\n${info.message}`;
    }
    state.hasValue = false;
    state.text = "";
    ui.stats.hidden = true;
    ui.outText.textContent = "";
    ui.outTree.replaceChildren();
    setBanner("err", message);
    if (info.offset !== null) {
      ui.input.focus();
      ui.input.setSelectionRange(info.offset, Math.min(text.length, info.offset + 1));
    }
    runQuery();
  }

  // ---------- 渲染输出 ----------
  function showText(text) {
    state.text = text;
    if (text.length > HIGHLIGHT_LIMIT) ui.outText.textContent = text;
    else ui.outText.innerHTML = highlight(text);
  }

  function showPlain(text, kind, banner) {
    state.hasValue = false;
    state.value = undefined;
    state.text = text;
    ui.outText.textContent = text;
    ui.outTree.replaceChildren();
    ui.stats.hidden = true;
    setBanner(kind, banner);
    setView("text");
    runQuery();
  }

  function showStats(value, pretty, minified) {
    const m = measure(value);
    const items = [
      ["类型", typeName(value)], ["键数", m.keys.toLocaleString()], ["节点", m.nodes.toLocaleString()],
      ["最大深度", m.maxDepth], ["压缩后", formatBytes(byteSize(minified))], ["当前输出", formatBytes(byteSize(pretty))],
    ];
    ui.stats.replaceChildren(...items.map(([k, v]) => {
      const span = document.createElement("span");
      span.append(`${k} `);
      const b = document.createElement("b");
      b.textContent = v;
      span.append(b);
      return span;
    }));
    ui.stats.hidden = false;
  }

  function indentValue(mode) {
    if (mode === "minify") return 0;
    return ui.indent.value === "tab" ? "\t" : Number(ui.indent.value);
  }

  function run(mode) {
    const src = ui.input.value;
    if (!src.trim()) {
      state.hasValue = false;
      state.text = "";
      ui.outText.textContent = "";
      ui.outTree.replaceChildren();
      ui.stats.hidden = true;
      setBanner("", "");
      runQuery();
      return;
    }

    const notes = [];
    let value;
    try {
      value = JSON.parse(src);
    } catch (error) {
      if (!ui.loose.checked) return fail(error, src);
      try {
        value = JSON.parse(repair(src));
        notes.push("已修复非标准写法（注释、单引号、末尾逗号等）");
      } catch (_) {
        return fail(error, src);
      }
    }

    if (ui.unwrap.checked) {
      let guard = 0;
      while (typeof value === "string" && guard++ < 5 && /^\s*[[{"]/.test(value)) {
        try { value = JSON.parse(value); } catch (_) { break; }
        if (!notes.includes("已解开嵌套的 JSON 字符串")) notes.push("已解开嵌套的 JSON 字符串");
      }
    }

    if (/[:[,]\s*-?\d{16,}\s*[,\]}]/.test(src)) {
      notes.push("注意：含 16 位以上整数，JavaScript 会丢失精度，输出的数字可能与原文不同");
    }

    if (ui.sort.checked) value = sortDeep(value);

    let output = JSON.stringify(value, null, indentValue(mode));
    if (output === undefined) output = "";
    if (ui.ascii.checked) {
      output = output.replace(/[\u007f-\uffff]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
    }

    state.value = value;
    state.hasValue = true;
    state.treeDirty = true;
    showText(output);
    showStats(value, output, mode === "minify" ? output : JSON.stringify(value));

    const warn = notes.some((note) => note.startsWith("注意"));
    setBanner(warn ? "warn" : "ok", `✓ JSON 有效${notes.length ? "\n" + notes.join("\n") : ""}`);
    if (state.view === "tree") renderTree();
    runQuery();
  }

  // ---------- 转义 / 去转义 ----------
  function escapeText() {
    const src = ui.input.value;
    if (!src) return;
    showPlain(JSON.stringify(src), "ok", "✓ 已转义为 JSON 字符串字面量（可复制到代码里）");
  }

  function unescapeText() {
    const src = ui.input.value.trim();
    if (!src) return;
    let text;
    try {
      text = /^".*"$/s.test(src) ? JSON.parse(src) : JSON.parse(`"${src.replace(/\\?"/g, '\\"')}"`);
    } catch (error) {
      setBanner("err", `无法去转义：${error.message}`);
      return;
    }
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object") {
        ui.input.value = text;
        run("format");
        setBanner("ok", "✓ 已去转义，并按 JSON 格式化");
        return;
      }
    } catch (_) { /* 不是 JSON，按普通文本显示 */ }
    showPlain(text, "ok", "✓ 已去转义（结果不是 JSON，按普通文本显示）");
  }

  // ---------- 树形视图 ----------
  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function childPath(path, key, isArray) {
    if (isArray) return `${path}[${key}]`;
    return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}["${key.replace(/"/g, '\\"')}"]`;
  }

  function keyElement(key, path, isArray, isRoot) {
    const span = make("span", "tkey", isRoot ? "root" : isArray ? `[${key}]` : JSON.stringify(key));
    if (isRoot) span.classList.add("root");
    if (isArray) span.classList.add("idx");
    span.title = `点击复制路径：${path}`;
    span.addEventListener("click", () => {
      window.copyText(path.replace(/^\$\.?/, "") || "$", "已复制路径");
      ui.query.value = path.replace(/^\$\.?/, "");
      runQuery();
    });
    return span;
  }

  function valueElement(value) {
    const span = make("span", "tval");
    if (value === null) { span.className += " tk-null"; span.textContent = "null"; }
    else if (typeof value === "string") { span.className += " tk-str"; span.textContent = JSON.stringify(value); }
    else if (typeof value === "number") { span.className += " tk-num"; span.textContent = String(value); }
    else { span.className += " tk-bool"; span.textContent = String(value); }
    return span;
  }

  function buildNode(key, value, path, isRoot, parentIsArray, depth) {
    const wrap = make("div", "tnode");
    const line = make("div", "tline");
    const isContainer = value !== null && typeof value === "object";
    const toggle = make("span", "tog", isContainer ? "▾" : "");
    if (!isContainer) toggle.classList.add("leaf");
    line.append(toggle);
    if (key !== undefined || isRoot) {
      line.append(keyElement(key, path, parentIsArray, isRoot), make("span", "tpunc", ":"));
    }

    if (!isContainer) {
      line.append(valueElement(value));
      wrap.append(line);
      return wrap;
    }

    const isArray = Array.isArray(value);
    const entries = isArray ? value.map((v, i) => [i, v]) : Object.entries(value);
    const open = isArray ? "[" : "{";
    const close = isArray ? "]" : "}";
    const preview = make("span", "tpreview");
    preview.append(` … ${close}`, make("i", "", `${entries.length} ${isArray ? "项" : "键"}`));
    line.append(make("span", "tpunc", open), preview);

    const kids = make("div", "tchildren");
    const tail = make("div", "tline tail");
    tail.append(make("span", "tpunc", close));
    wrap.append(line, kids, tail);

    let built = 0;
    function buildMore() {
      const end = Math.min(entries.length, built + CHUNK);
      const frag = document.createDocumentFragment();
      for (; built < end; built++) {
        const [k, v] = entries[built];
        frag.append(buildNode(k, v, childPath(path, k, isArray), false, isArray, depth + 1));
      }
      const old = kids.querySelector(":scope > .more");
      if (old) old.remove();
      kids.append(frag);
      if (built < entries.length) {
        const more = make("button", "tbtn sm more", `还有 ${entries.length - built} 项，点击加载`);
        more.type = "button";
        more.addEventListener("click", buildMore);
        kids.append(more);
      }
    }

    function setOpen(opened) {
      wrap.classList.toggle("collapsed", !opened);
      toggle.textContent = opened ? "▾" : "▸";
      if (opened && built === 0 && entries.length) buildMore();
    }

    wrap._setOpen = setOpen;
    toggle.addEventListener("click", () => setOpen(wrap.classList.contains("collapsed")));
    setOpen(depth < 2);
    return wrap;
  }

  function renderTree() {
    if (!state.hasValue) { ui.outTree.replaceChildren(); return; }
    ui.outTree.replaceChildren(buildNode(undefined, state.value, "$", true, false, 0));
    state.treeDirty = false;
  }

  function expandAll() {
    let rounds = 0;
    while (rounds++ < 50) {
      const closed = ui.outTree.querySelectorAll(".tnode.collapsed");
      if (!closed.length) break;
      closed.forEach((node) => node._setOpen && node._setOpen(true));
      if (ui.outTree.querySelectorAll(".tnode").length > TREE_NODE_LIMIT) {
        window.toast("节点太多，只展开了一部分", true);
        break;
      }
    }
  }

  function collapseAll() {
    ui.outTree.querySelectorAll(".tnode").forEach((node, index) => {
      if (node._setOpen) node._setOpen(index === 0);
    });
  }

  function setView(view) {
    state.view = view;
    const tree = view === "tree";
    ui.outText.hidden = tree;
    ui.outTree.hidden = !tree;
    ui.treeTools.hidden = !tree;
    ui.tabText.classList.toggle("active", !tree);
    ui.tabTree.classList.toggle("active", tree);
    if (tree && state.treeDirty) renderTree();
  }

  // ---------- 路径查询 ----------
  function resolvePath(root, raw) {
    const path = raw.trim().replace(/^\$/, "");
    const pattern = /\[(\d+)\]|\["((?:[^"\\]|\\.)*)"\]|\['([^']*)'\]|\.?([^.[\]]+)/g;
    let current = root;
    let match;
    let walked = "$";
    while ((match = pattern.exec(path))) {
      let key;
      if (match[1] !== undefined) key = match[1];
      else if (match[2] !== undefined) key = JSON.parse(`"${match[2]}"`);
      else if (match[3] !== undefined) key = match[3];
      else key = match[4];
      if (current === null || typeof current !== "object" || !Object.prototype.hasOwnProperty.call(current, key)) {
        return { found: false, at: `${walked}.${key}` };
      }
      current = current[key];
      walked += `.${key}`;
    }
    return { found: true, value: current };
  }

  let queryResult = "";
  function runQuery() {
    const raw = ui.query.value;
    ui.queryOut.className = "query-out";
    queryResult = "";
    if (!raw.trim()) { ui.queryOut.textContent = ""; return; }
    if (!state.hasValue) {
      ui.queryOut.classList.add("miss");
      ui.queryOut.textContent = "请先格式化一份有效的 JSON。";
      return;
    }
    const result = resolvePath(state.value, raw);
    if (!result.found) {
      ui.queryOut.classList.add("miss");
      ui.queryOut.textContent = `未找到：${result.at}`;
      return;
    }
    queryResult = JSON.stringify(result.value, null, 2);
    if (queryResult === undefined) queryResult = String(result.value);
    ui.queryOut.innerHTML = highlight(queryResult);
  }

  // ---------- 事件 ----------
  function updateCount() {
    const text = ui.input.value;
    const lines = text ? text.split("\n").length : 0;
    ui.inCount.textContent = `${text.length.toLocaleString()} 字符 · ${lines} 行 · ${formatBytes(byteSize(text))}`;
  }

  let saveTimer;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        if (ui.input.value.length < MAX_STORE) localStorage.setItem(STORE_KEY, ui.input.value);
      } catch (_) { /* 存储不可用时忽略 */ }
    }, 400);
  }

  function loadFile(file) {
    if (!file) return;
    file.text().then((text) => {
      ui.input.value = text;
      updateCount();
      persist();
      run("format");
    });
  }

  ui.input.addEventListener("input", () => { updateCount(); persist(); });
  ui.input.addEventListener("paste", () => {
    if (ui.paste.checked) setTimeout(() => { updateCount(); run("format"); }, 0);
  });
  ui.input.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      run("format");
    }
  });
  ui.input.addEventListener("dragover", (event) => event.preventDefault());
  ui.input.addEventListener("drop", (event) => {
    event.preventDefault();
    loadFile(event.dataTransfer.files[0]);
  });

  $("#btnFormat").addEventListener("click", () => run("format"));
  $("#btnMinify").addEventListener("click", () => run("minify"));
  $("#btnEscape").addEventListener("click", escapeText);
  $("#btnUnescape").addEventListener("click", unescapeText);
  $("#btnSample").addEventListener("click", () => {
    ui.input.value = SAMPLE;
    updateCount();
    persist();
    run("format");
  });
  $("#btnClear").addEventListener("click", () => {
    ui.input.value = "";
    updateCount();
    persist();
    run("format");
    ui.input.focus();
  });
  $("#fileInput").addEventListener("change", (event) => {
    loadFile(event.target.files[0]);
    event.target.value = "";
  });

  [ui.indent, ui.sort, ui.ascii].forEach((control) =>
    control.addEventListener("change", () => { if (ui.input.value.trim()) run("format"); }));

  ui.tabText.addEventListener("click", () => setView("text"));
  ui.tabTree.addEventListener("click", () => setView("tree"));
  $("#btnExpand").addEventListener("click", expandAll);
  $("#btnCollapse").addEventListener("click", collapseAll);

  $("#btnCopy").addEventListener("click", () => {
    if (!state.text) return window.toast("没有可复制的内容", true);
    window.copyText(state.text, "已复制输出");
  });
  $("#btnDownload").addEventListener("click", () => {
    if (!state.text) return window.toast("没有可下载的内容", true);
    window.downloadText(state.text, "formatted.json", "application/json;charset=utf-8");
  });
  $("#btnApply").addEventListener("click", () => {
    if (!state.text) return window.toast("没有可应用的内容", true);
    ui.input.value = state.text;
    updateCount();
    persist();
  });

  ui.query.addEventListener("input", runQuery);
  $("#btnQueryCopy").addEventListener("click", () => {
    if (!queryResult) return window.toast("没有可复制的结果", true);
    window.copyText(queryResult, "已复制查询结果");
  });

  // ---------- 初始化 ----------
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (saved) ui.input.value = saved;
  } catch (_) { /* 忽略 */ }
  updateCount();
  if (ui.input.value.trim()) run("format");
})();
