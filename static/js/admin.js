(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const csrf = document.querySelector('meta[name="csrf-token"]').content;

  let toastTimer = null;
  function toast(msg, isError) {
    const el = $("#toast");
    el.textContent = msg;
    el.className = "toast" + (isError ? " error" : "");
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, 3600);
  }

  const modalEl = $("#modal");
  const modalInput = $("#modal-input");
  let modalResolve = null;

  function openModal(opts) {
    return new Promise((resolve) => {
      modalResolve = resolve;
      $("#modal-title").textContent = opts.title || "提示";
      $("#modal-desc").textContent = opts.desc || "";
      $("#modal-ok").textContent = opts.okText || "确定";
      $("#modal-ok").className = "btn btn-sm " + (opts.danger ? "btn-danger" : "btn-primary");
      const hasInput = !!opts.input;
      modalInput.hidden = !hasInput;
      modalInput.value = (hasInput && opts.input.value) || "";
      modalInput.placeholder = (hasInput && opts.input.placeholder) || "";
      modalEl.hidden = false;
      if (hasInput) {
        modalInput.focus();
        modalInput.select();
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
  $("#modal-ok").addEventListener("click", () => closeModal(modalInput.hidden ? true : modalInput.value));
  modalInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      $("#modal-ok").click();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modalEl.hidden) closeModal(null);
  });

  async function callApi(payload) {
    const res = await fetch("/api/admin/user", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify(payload),
    });
    if (res.status === 401) {
      location.href = "/login?next=/admin";
      throw new Error("未登录");
    }
    let data = {};
    try {
      data = await res.json();
    } catch (err) {
      data = { ok: false, error: "服务器响应异常" };
    }
    if (!res.ok || data.ok === false) throw new Error(data.error || "操作失败");
    return data;
  }

  async function handleAction(button) {
    const action = button.dataset.action;
    const username = button.closest(".admin-actions").dataset.user;

    if (action === "approve" || action === "reject" || action === "disable" || action === "enable") {
      const labels = {
        approve: ["通过注册申请", "通过"],
        reject: ["拒绝注册申请", "拒绝"],
        disable: ["禁用账号", "禁用"],
        enable: ["启用账号", "启用"],
      };
      const [title, okText] = labels[action];
      const ok = await openModal({
        title: title,
        desc: `确认对账号「${username}」执行该操作？`,
        okText: okText,
        danger: action === "reject" || action === "disable",
      });
      if (!ok) return;
      try {
        const data = await callApi({ action: action, username: username });
        toast(data.msg || "操作成功");
        setTimeout(() => location.reload(), 600);
      } catch (err) {
        toast(err.message, true);
      }
      return;
    }

    if (action === "reset") {
      const ok = await openModal({
        title: "重置密码",
        desc: `将为「${username}」生成一个临时密码，请把新密码告知对方。`,
        okText: "重置",
        danger: true,
      });
      if (!ok) return;
      try {
        const data = await callApi({ action: "reset", username: username });
        await openModal({
          title: "临时密码已生成",
          desc: `${username} 的新密码：${data.password}（请立即告知对方并提醒登录后修改）`,
          okText: "知道了",
        });
        setTimeout(() => location.reload(), 400);
      } catch (err) {
        toast(err.message, true);
      }
      return;
    }

    if (action === "quota") {
      const usageCell = button.closest("tr").querySelector(".admin-usage").textContent;
      const value = await openModal({
        title: "调整容量上限",
        desc: `账号「${username}」当前已用/上限：${usageCell}，请输入新的上限（单位 GB）。`,
        input: { placeholder: "例如 5", value: "5" },
        okText: "保存",
      });
      if (value === null) return;
      const gb = parseFloat(String(value).trim());
      if (!isFinite(gb) || gb <= 0) return toast("请输入大于 0 的数字（GB）", true);
      try {
        const data = await callApi({ action: "quota", username: username, quota_gb: gb });
        toast(data.msg || "容量已更新");
        setTimeout(() => location.reload(), 600);
      } catch (err) {
        toast(err.message, true);
      }
    }
  }

  document.querySelectorAll(".admin-actions button").forEach((btn) => {
    btn.addEventListener("click", () => handleAction(btn));
  });
})();