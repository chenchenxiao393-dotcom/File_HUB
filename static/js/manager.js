(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const csrf = document.querySelector('meta[name="csrf-token"]').content;

  const listEl = $("#list");
  const treeEl = $("#tree");
  const crumbEl = $("#breadcrumb");
  const listWrap = $("#list-wrap");
  const fileInput = $("#file-input");
  const searchEl = $("#search");

  const btnUp = $("#btn-up");
  const btnRefresh = $("#btn-refresh");
  const btnUpload = $("#btn-upload");
  const btnNewFolder = $("#btn-new-folder");
  const btnDownload = $("#btn-download");
  const btnRename = $("#btn-rename");
  const btnDelete = $("#btn-delete");

  const state = {
    cwd: "",
    parent: null,
    entries: [],
    selected: new Set(),
    lastIndex: -1,
    filter: "",
    sort: { key: "name", dir: 1 },
  };

  const ICONS = {
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    file: '<path d="M6 3h7l5 5v13H6z"/><path d="M13 3v5h5"/>',
    image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M4 17l5-5 4 4 3-2 4 3"/>',
    doc: '<path d="M6 3h7l5 5v13H6z"/><path d="M13 3v5h5"/><path d="M9 13h6M9 17h4"/>',
    sheet: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 10h16M10 4v16"/>',
    archive: '<path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M12 5v4M10 9h4M12 9v3"/>',
    media: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M10 9.5l5 2.5-5 2.5z"/>',
    code: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4"/>',
  };

  const EXT_MAP = {
    image: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"],
    sheet: ["xls", "xlsx", "csv"],
    doc: ["doc", "docx", "pdf", "txt", "md", "rtf", "ppt", "pptx"],
    archive: ["zip", "rar", "7z", "tar", "gz", "bz2", "xz"],
    media: ["mp4", "mkv", "mov", "avi", "mp3", "wav", "flac", "m4a"],
    code: ["js", "ts", "json", "html", "css", "py", "go", "java", "sh", "xml", "yml", "yaml", "sql"],
  };

  function iconFor(entry) {
    let key = "file";
    if (entry.type === "dir") key = "folder";
    else {
      for (const [group, exts] of Object.entries(EXT_MAP)) {
        if (exts.includes(entry.ext)) {
          key = group === "sheet" ? "sheet" : group;
          break;
        }
      }
    }
    return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONS[key]}</svg>`;
  }

  function typeLabel(entry) {
    if (entry.type === "dir") return "文件夹";
    if (!entry.ext) return "文件";
    const group = Object.keys(EXT_MAP).find((k) => EXT_MAP[k].includes(entry.ext));
    const names = { image: "图片", sheet: "表格", doc: "文档", archive: "压缩包", media: "媒体", code: "代码" };
    return `${entry.ext.toUpperCase()} ${group ? names[group] : "文件"}`;
  }

  function fmtSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let val = bytes / 1024;
    let i = 0;
    while (val >= 1024 && i < units.length - 1) {
      val /= 1024;
      i++;
    }
    return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
  }

  async function api(url, opts) {
    const options = opts || {};
    const headers = Object.assign({}, options.headers);
    if (options.method && options.method !== "GET") headers["X-CSRF-Token"] = csrf;
    const res = await fetch(url, Object.assign({}, options, { headers }));
    if (res.status === 401) {
      location.href = "/login?next=/app";
      throw new Error("未登录");
    }
    let data = {};
    try {
      data = await res.json();
    } catch (err) {
      data = { ok: false, error: "服务器响应异常" };
    }
    if (!res.ok || data.ok === false) {
      if (data.code === "csrf" && res.status === 403) location.reload();
      throw new Error(data.error || "请求失败");
    }
    return data;
  }

  let toastTimer = null;
  function toast(msg, isError) {
    const el = $("#toast");
    el.textContent = msg;
    el.className = "toast" + (isError ? " error" : "");
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, 2600);
  }

  function setStatus(text) {
    $("#status").textContent = text;
  }

  // ---------------------------------------------------------------- 弹窗
  const modalEl = $("#modal");
  const modalInput = $("#modal-input");
  const modalInput2 = $("#modal-input-2");
  let modalResolve = null;

  function openModal(opts) {
    return new Promise((resolve) => {
      modalResolve = resolve;
      $("#modal-title").textContent = opts.title || "提示";
      $("#modal-desc").textContent = opts.desc || "";
      $("#modal-ok").textContent = opts.okText || "确定";
      $("#modal-ok").className = "btn btn-sm " + (opts.danger ? "btn-danger" : "btn-primary");

      modalInput.hidden = !opts.input;
      modalInput.value = (opts.input && opts.input.value) || "";
      modalInput.placeholder = (opts.input && opts.input.placeholder) || "";
      modalInput.type = (opts.input && opts.input.type) || "text";

      modalInput2.hidden = !opts.input2;
      modalInput2.value = "";
      modalInput2.placeholder = (opts.input2 && opts.input2.placeholder) || "";
      modalInput2.type = (opts.input2 && opts.input2.type) || "password";

      modalEl.hidden = false;
      if (opts.input) {
        modalInput.focus();
        if (opts.selectAll) modalInput.select();
      } else {
        $("#modal-ok").focus();
      }
    });
  }

  function closeModal(result) {
    modalEl.hidden = true;
    const resolve = modalResolve;
    modalResolve = null;
    if (resolve) resolve(result);
  }

  $("#modal-cancel").addEventListener("click", () => closeModal(null));
  modalEl.addEventListener("click", (e) => {
    if (e.target === modalEl) closeModal(null);
  });
  $("#modal-ok").addEventListener("click", () => {
    const hasInput = !modalInput.hidden;
    const hasInput2 = !modalInput2.hidden;
    if (!hasInput && !hasInput2) return closeModal(true);
    if (hasInput2) return closeModal({ first: modalInput.value, second: modalInput2.value });
    closeModal(modalInput.value);
  });
  [modalInput, modalInput2].forEach((input) => {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        $("#modal-ok").click();
      }
    });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modalEl.hidden) closeModal(null);
  });

  // ---------------------------------------------------------------- 列表
  function sortedEntries() {
    const key = state.sort.key;
    const dir = state.sort.dir;
    const kw = state.filter.trim().toLowerCase();
    const rows = state.entries.filter((e) => !kw || e.name.toLowerCase().includes(kw));
    rows.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      let va, vb;
      if (key === "size") {
        va = a.size;
        vb = b.size;
      } else if (key === "mtime") {
        va = a.mtime;
        vb = b.mtime;
      } else if (key === "type") {
        va = typeLabel(a).toLowerCase();
        vb = typeLabel(b).toLowerCase();
      } else {
        va = a.name.toLowerCase();
        vb = b.name.toLowerCase();
      }
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return 0;
    });
    return rows;
  }

  function renderList() {
    const rows = sortedEntries();
    listEl.innerHTML = "";

    if (!rows.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      if (state.filter) {
        empty.innerHTML = "<strong>没有匹配的项目</strong>换个关键词试试";
      } else {
        empty.innerHTML =
          "<strong>此文件夹为空</strong>点击「上传」或把文件拖到这里开始使用";
      }
      listEl.appendChild(empty);
      updateSelectionUI();
      return;
    }

    rows.forEach((entry, index) => {
      const row = document.createElement("div");
      row.className = "row" + (state.selected.has(entry.path) ? " selected" : "");
      row.dataset.path = entry.path;
      row.dataset.index = String(index);

      const nameCell = document.createElement("div");
      nameCell.className = "cell-name";
      const icon = document.createElement("span");
      icon.className = "file-icon " + entry.type;
      icon.innerHTML = iconFor(entry);
      const name = document.createElement("span");
      name.className = "fname";
      name.textContent = entry.name;
      name.title = entry.name;
      nameCell.append(icon, name);

      const mtime = document.createElement("div");
      mtime.className = "cell-mtime";
      mtime.textContent = entry.mtime;

      const type = document.createElement("div");
      type.className = "cell-type";
      type.textContent = typeLabel(entry);

      const size = document.createElement("div");
      size.className = "cell-size";
      size.textContent = entry.type === "dir" ? "—" : fmtSize(entry.size);

      row.append(nameCell, mtime, type, size);

      row.addEventListener("click", (e) => onRowClick(entry, index, e));
      row.addEventListener("dblclick", () => openEntry(entry));
      listEl.appendChild(row);
    });

    updateSelectionUI();
  }

  function onRowClick(entry, index, event) {
    if (event.shiftKey && state.lastIndex >= 0) {
      const rows = sortedEntries();
      const [from, to] = [state.lastIndex, index].sort((a, b) => a - b);
      state.selected.clear();
      for (let i = from; i <= to; i++) state.selected.add(rows[i].path);
    } else if (event.ctrlKey || event.metaKey) {
      if (state.selected.has(entry.path)) state.selected.delete(entry.path);
      else state.selected.add(entry.path);
      state.lastIndex = index;
    } else {
      state.selected.clear();
      state.selected.add(entry.path);
      state.lastIndex = index;
    }
    document.querySelectorAll(".row").forEach((el) => {
      el.classList.toggle("selected", state.selected.has(el.dataset.path));
    });
    updateSelectionUI();
  }

  function updateSelectionUI() {
    const count = state.selected.size;
    btnDownload.disabled = count !== 1;
    btnRename.disabled = count !== 1;
    btnDelete.disabled = count === 0;
    $("#selection-info").textContent = count ? `已选中 ${count} 项` : "";
    setStatus(`共 ${state.entries.length} 个项目`);
  }

  function selectedEntry() {
    const path = [...state.selected][0];
    return state.entries.find((e) => e.path === path) || null;
  }

  function openEntry(entry) {
    if (entry.type === "dir") loadDir(entry.path);
    else download(entry.path);
  }

  function download(path) {
    window.location.href = "/api/download?path=" + encodeURIComponent(path);
  }

  function renderBreadcrumb(crumbs) {
    crumbEl.innerHTML = "";
    crumbs.forEach((crumb, i) => {
      if (i > 0) {
        const sep = document.createElement("span");
        sep.className = "crumb-sep";
        sep.textContent = "/";
        crumbEl.appendChild(sep);
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "crumb" + (i === crumbs.length - 1 ? " current" : "");
      btn.textContent = crumb.name;
      btn.title = crumb.path || "根目录";
      if (i !== crumbs.length - 1) btn.addEventListener("click", () => loadDir(crumb.path));
      crumbEl.appendChild(btn);
    });
  }

  async function loadDir(path) {
    setStatus("加载中…");
    try {
      const data = await api("/api/list?path=" + encodeURIComponent(path || ""));
      state.cwd = data.path;
      state.parent = data.parent;
      state.entries = data.entries;
      state.selected.clear();
      state.lastIndex = -1;
      state.filter = "";
      searchEl.value = "";
      renderBreadcrumb(data.breadcrumbs);
      renderList();
      btnUp.disabled = data.parent === null;
      const quotaInfo = $("#quota-info");
      if (quotaInfo && data.usage_text) quotaInfo.textContent = data.usage_text;
      syncTree(data.path);
    } catch (err) {
      toast(err.message, true);
      setStatus("加载失败");
    }
  }

  // ---------------------------------------------------------------- 目录树
  const treeNodes = new Map();

  const TREE_CARET =
    '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
  const TREE_FOLDER =
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';

  function createTreeNode(path, name, mount) {
    const node = document.createElement("div");
    node.className = "tree-node";
    const row = document.createElement("div");
    row.className = "tree-row";
    row.setAttribute("role", "treeitem");
    row.innerHTML = `<span class="tree-caret">${TREE_CARET}</span><span class="tree-icon">${TREE_FOLDER}</span><span class="tree-label"></span>`;
    row.querySelector(".tree-label").textContent = name;
    const children = document.createElement("div");
    children.className = "tree-children";
    node.append(row, children);
    mount.appendChild(node);

    const info = { path, name, node, row, children, loaded: false, expanded: false, loading: false };
    treeNodes.set(path, info);

    row.querySelector(".tree-caret").addEventListener("click", (e) => {
      e.stopPropagation();
      toggleNode(info);
    });
    row.addEventListener("click", () => loadDir(path));
    return info;
  }

  async function toggleNode(info) {
    if (info.expanded) {
      info.expanded = false;
      info.node.classList.remove("expanded");
      return;
    }
    info.expanded = true;
    info.node.classList.add("expanded");
    if (info.loaded) return;
    info.loading = true;
    const tip = document.createElement("div");
    tip.className = "tree-loading";
    tip.textContent = "加载中…";
    info.children.appendChild(tip);
    try {
      const data = await api("/api/tree?path=" + encodeURIComponent(info.path));
      info.children.innerHTML = "";
      data.dirs.forEach((dir) => createTreeNode(dir.path, dir.name, info.children));
      info.loaded = true;
      if (!data.dirs.length) info.row.querySelector(".tree-caret").classList.add("empty");
    } catch (err) {
      tip.remove();
      info.expanded = false;
      info.node.classList.remove("expanded");
      toast(err.message, true);
    } finally {
      info.loading = false;
    }
  }

  async function expandNode(info) {
    if (!info.loaded) await loadChildren(info);
    info.expanded = true;
    info.node.classList.add("expanded");
  }

  async function ensureAncestors(path) {
    if (!path) return;
    const parts = path.split("/").filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      const parentPath = parts.slice(0, i).join("/");
      const info = treeNodes.get(parentPath);
      if (!info) return;
      await expandNode(info);
    }
  }

  async function syncTree(path) {
    treeNodes.forEach((info) => info.row.classList.remove("active"));
    await ensureAncestors(path);
    const info = treeNodes.get(path);
    if (info) {
      info.row.classList.add("active");
      info.row.scrollIntoView({ block: "nearest" });
    }
  }

  async function resetTree() {
    treeNodes.clear();
    treeEl.innerHTML = "";
    const root = createTreeNode("", "根目录", treeEl);
    root.expanded = true;
    root.node.classList.add("expanded");
    await loadChildren(root);
  }

  async function loadChildren(info) {
    try {
      const data = await api("/api/tree?path=" + encodeURIComponent(info.path));
      info.children.innerHTML = "";
      data.dirs.forEach((dir) => createTreeNode(dir.path, dir.name, info.children));
      info.loaded = true;
      if (!data.dirs.length) info.row.querySelector(".tree-caret").classList.add("empty");
      else info.row.querySelector(".tree-caret").classList.remove("empty");
    } catch (err) {
      toast(err.message, true);
    }
  }

  // ---------------------------------------------------------------- 上传
  function uploadFiles(files) {
    const list = Array.from(files || []);
    if (!list.length) return;

    const form = new FormData();
    list.forEach((file) => form.append("files", file, file.name));

    const box = $("#progress");
    const fill = $("#progress-fill");
    const text = $("#progress-text");
    box.hidden = false;
    fill.style.width = "0%";
    text.textContent = `准备上传 ${list.length} 个文件…`;

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload?path=" + encodeURIComponent(state.cwd));
    xhr.setRequestHeader("X-CSRF-Token", csrf);
    // 让上传请求也带上进度总长度（浏览器自动计算，无需 Content-Length 头）
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.round((e.loaded / e.total) * 100);
      fill.style.width = pct + "%";
      text.textContent = `上传中… ${pct}%`;
    };
    xhr.onload = () => {
      box.hidden = true;
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch (err) {
        data = {};
      }
      if (xhr.status === 401) {
        location.href = "/login?next=/app";
        return;
      }
      if (xhr.status === 413) {
        toast("文件过大，单次上传上限 2GB", true);
        return;
      }
      if (!data.saved || !data.saved.length) {
        const reason = (data.failed && data.failed[0] && data.failed[0].error) || data.error || "上传失败";
        toast(reason, true);
        return;
      }
      const failedCount = (data.failed || []).length;
      toast(failedCount ? `已上传 ${data.saved.length} 个，${failedCount} 个失败` : `已上传 ${data.saved.length} 个文件`);
      const quotaInfo = $("#quota-info");
      if (quotaInfo && data.used_quota_text) quotaInfo.textContent = data.used_quota_text;
      loadDir(state.cwd);
      resetTree().then(() => syncTree(state.cwd));
    };
    xhr.onerror = () => {
      box.hidden = true;
      toast("上传失败，请检查网络后重试", true);
    };
    xhr.send(form);
  }

  // ---------------------------------------------------------------- 操作
  async function newFolder() {
    const name = await openModal({
      title: "新建文件夹",
      desc: `位置：/${state.cwd}`,
      input: { placeholder: "文件夹名称" },
    });
    if (name === null) return;
    const name2 = name.trim();
    if (!name2) return toast("名称不能为空", true);
    try {
      await api("/api/mkdir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: state.cwd, name: name2 }),
      });
      toast("文件夹已创建");
      loadDir(state.cwd);
      resetTree().then(() => syncTree(state.cwd));
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function renameSelection() {
    const entry = selectedEntry();
    if (!entry) return;
    const name = await openModal({
      title: "重命名",
      desc: entry.path,
      input: { value: entry.name, placeholder: "新名称" },
      selectAll: true,
      okText: "保存",
    });
    if (name === null) return;
    const name2 = name.trim();
    if (!name2 || name2 === entry.name) return;
    try {
      await api("/api/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: entry.path, name: name2 }),
      });
      toast("已重命名");
      loadDir(state.cwd);
      resetTree().then(() => syncTree(state.cwd));
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function deleteSelection() {
    const paths = [...state.selected];
    if (!paths.length) return;
    const label = paths.length === 1 ? `「${selectedEntry() ? selectedEntry().name : paths[0]}」` : `选中的 ${paths.length} 个项目`;
    const ok = await openModal({
      title: "确认删除",
      desc: `${label} 将被永久删除，且无法恢复。`,
      okText: "删除",
      danger: true,
    });
    if (!ok) return;
    try {
      const data = await api("/api/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths }),
      });
      if (data.failed && data.failed.length) toast(`已删除 ${data.deleted.length} 项，${data.failed.length} 项失败`, true);
      else toast(`已删除 ${data.deleted.length} 项`);
      state.selected.clear();
      loadDir(state.cwd);
      resetTree().then(() => syncTree(state.cwd));
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function changePassword() {
    const result = await openModal({
      title: "修改登录密码",
      desc: "新密码至少 8 位，修改后请重新登录。",
      input: { placeholder: "当前密码", type: "password" },
      input2: { placeholder: "新密码", type: "password" },
      okText: "更新",
    });
    if (result === null) return;
    if (!result.first || result.second.length < 8) return toast("请填写当前密码，新密码至少 8 位", true);
    try {
      await api("/api/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ old_password: result.first, new_password: result.second }),
      });
      toast("密码已更新，即将重新登录");
      setTimeout(async () => {
        try {
          await fetch("/logout", { method: "POST", headers: { "X-CSRF-Token": csrf } });
        } catch (err) {
          /* 忽略网络异常，直接跳转登录页 */
        }
        location.href = "/login";
      }, 900);
    } catch (err) {
      toast(err.message, true);
    }
  }

  // ---------------------------------------------------------------- 事件绑定
  btnUp.addEventListener("click", () => {
    if (state.parent !== null) loadDir(state.parent);
  });
  btnRefresh.addEventListener("click", () => loadDir(state.cwd));
  btnUpload.addEventListener("click", () => fileInput.click());
  btnNewFolder.addEventListener("click", newFolder);
  $("#btn-new-folder-side").addEventListener("click", newFolder);
  btnRename.addEventListener("click", renameSelection);
  btnDelete.addEventListener("click", deleteSelection);
  $("#btn-password").addEventListener("click", changePassword);
  btnDownload.addEventListener("click", () => {
    const entry = selectedEntry();
    if (entry) download(entry.path);
  });

  fileInput.addEventListener("change", () => {
    uploadFiles(fileInput.files);
    fileInput.value = "";
  });

  searchEl.addEventListener("input", () => {
    state.filter = searchEl.value;
    renderList();
  });

  let dragDepth = 0;
  listWrap.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes("Files")) return;
    e.preventDefault();
    dragDepth++;
    listWrap.classList.add("dragging");
  });
  listWrap.addEventListener("dragover", (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  });
  listWrap.addEventListener("dragleave", () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) listWrap.classList.remove("dragging");
  });
  listWrap.addEventListener("drop", (e) => {
    if (!e.dataTransfer) return;
    e.preventDefault();
    dragDepth = 0;
    listWrap.classList.remove("dragging");
    uploadFiles(e.dataTransfer.files);
  });

  listWrap.addEventListener("click", (e) => {
    if (e.target.closest(".row")) return;
    state.selected.clear();
    document.querySelectorAll(".row.selected").forEach((el) => el.classList.remove("selected"));
    updateSelectionUI();
  });

  document.querySelectorAll(".list-head span").forEach((head) => {
    head.addEventListener("click", () => {
      const key = head.dataset.key;
      state.sort = { key, dir: state.sort.key === key ? -state.sort.dir : 1 };
      document.querySelectorAll(".list-head span").forEach((el) => el.classList.remove("sorted"));
      head.classList.add("sorted");
      renderList();
    });
  });

  document.addEventListener("keydown", (e) => {
    if (!modalEl.hidden) return;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)) return;
    if (e.key === "Delete" && state.selected.size) deleteSelection();
    if (e.key === "F2" && state.selected.size === 1) {
      e.preventDefault();
      renameSelection();
    }
    if (e.key === "Escape") {
      state.selected.clear();
      renderList();
    }
  });

  // ---------------------------------------------------------------- 初始化
  (async function init() {
    await resetTree();
    await loadDir("");
  })();
})();
