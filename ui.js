/* 共用小工具：提示、复制、下载 */
(function () {
  "use strict";
  let node;
  let timer;

  window.toast = function (message, isError) {
    if (!node) {
      node = document.createElement("div");
      node.className = "toast";
      node.setAttribute("role", "status");
      document.body.append(node);
    }
    node.textContent = message;
    node.classList.toggle("err", Boolean(isError));
    node.classList.add("show");
    clearTimeout(timer);
    timer = setTimeout(() => node.classList.remove("show"), 1600);
  };

  window.copyText = async function (text, label) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (error) {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.cssText = "position:fixed;opacity:0;left:-9999px";
      document.body.append(area);
      area.select();
      let ok = false;
      try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
      area.remove();
      if (!ok) {
        window.toast("复制失败，请手动复制", true);
        return false;
      }
    }
    window.toast(label || "已复制");
    return true;
  };

  window.downloadText = function (text, fileName, type) {
    const url = URL.createObjectURL(new Blob([text], { type: type || "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
})();
