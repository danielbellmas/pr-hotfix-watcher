// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
      .replace(/`/g, "&#96;");
  }

  function badge(row) {
    const merged = Boolean(row.mergedAt);
    if (merged) {
      return '<span class="badge merged"><span class="ico">✓</span>Merged</span>';
    }
    if (row.state === "open") {
      return '<span class="badge open"><span class="ico">●</span>Open</span>';
    }
    return '<span class="badge closed"><span class="ico">○</span>Closed</span>';
  }

  function watchEntryBadge(e) {
    if (e.merged) {
      return '<span class="badge merged"><span class="ico">✓</span>Merged</span>';
    }
    if (e.state === "open") {
      return '<span class="badge open"><span class="ico">●</span>Open</span>';
    }
    return '<span class="badge closed"><span class="ico">○</span>Closed</span>';
  }

  const searchEl = document.getElementById("search");
  const searchStatus = document.getElementById("searchStatus");
  if (searchEl) {
    searchEl.addEventListener("input", () => {
      vscode.postMessage({ command: "searchQuery", query: searchEl.value });
    });
  }

  const envSel = document.getElementById("hotfixEnvSel");
  const draftCb = document.getElementById("hotfixDraftCb");
  const ftCb = document.getElementById("hotfixFtCb");
  const deployCb = document.getElementById("hotfixDeployCb");
  function postHotfixCli() {
    if (!envSel || !draftCb || !ftCb || !deployCb) return;
    vscode.postMessage({
      command: "hotfixCli",
      env: envSel.value,
      draft: draftCb.checked,
      criticalFastTrack: ftCb.checked,
      deploy: deployCb.checked,
    });
  }
  if (envSel) envSel.addEventListener("change", postHotfixCli);
  if (draftCb) draftCb.addEventListener("change", postHotfixCli);
  if (ftCb) ftCb.addEventListener("change", postHotfixCli);
  if (deployCb) deployCb.addEventListener("change", postHotfixCli);

  const statusSel = document.getElementById("prStatusFilterSel");
  const sortSel = document.getElementById("prSortSel");
  function postPrListView() {
    if (!statusSel || !sortSel) return;
    vscode.postMessage({
      command: "prListView",
      statusFilter: statusSel.value,
      sortMode: sortSel.value,
    });
  }
  if (statusSel) statusSel.addEventListener("change", postPrListView);
  if (sortSel) sortSel.addEventListener("change", postPrListView);

  function render(state) {
    const meta = document.getElementById("meta");
    const pills = document.getElementById("pills");
    const list = document.getElementById("list");
    if (searchEl && document.activeElement !== searchEl && state.searchQuery !== undefined) {
      if (searchEl.value !== state.searchQuery) {
        searchEl.value = state.searchQuery;
      }
    }
    if (searchStatus) {
      searchStatus.classList.remove("err");
      let st = "";
      if (state.searchRemoteLoading) {
        st = "Searching GitHub…";
      } else if (state.searchRemoteError) {
        st = state.searchRemoteError;
        searchStatus.classList.add("err");
      }
      searchStatus.textContent = st;
    }
    if (state.hotfixCli && envSel && draftCb && ftCb && deployCb) {
      if (envSel.value !== state.hotfixCli.env) {
        envSel.value = state.hotfixCli.env;
      }
      if (draftCb.checked !== state.hotfixCli.draft) {
        draftCb.checked = state.hotfixCli.draft;
      }
      if (ftCb.checked !== state.hotfixCli.criticalFastTrack) {
        ftCb.checked = state.hotfixCli.criticalFastTrack;
      }
      if (deployCb.checked !== Boolean(state.hotfixCli.deploy)) {
        deployCb.checked = Boolean(state.hotfixCli.deploy);
      }
    }
    if (state.prListView && statusSel && sortSel) {
      if (statusSel.value !== state.prListView.statusFilter) {
        statusSel.value = state.prListView.statusFilter;
      }
      if (sortSel.value !== state.prListView.sortMode) {
        sortSel.value = state.prListView.sortMode;
      }
    }

    const watchPanel = document.getElementById("watchPanel");
    const watchHeadline = document.getElementById("watchHeadline");
    const watchHotfix = document.getElementById("watchHotfix");
    const watchList = document.getElementById("watchList");
    if (watchPanel && watchHeadline && watchHotfix && watchList) {
      const wp = state.watchPanel;
      if (wp && state.watching) {
        watchPanel.hidden = false;
        watchHeadline.textContent = wp.statusLine || "";
        watchHotfix.textContent = wp.hotfixSummary || "";
        watchList.innerHTML = wp.entries
          .map(
            (e) =>
              '<div class="watch-line">' +
              watchEntryBadge(e) +
              '<span class="watch-num">#' +
              e.number +
              "</span>" +
              '<span class="watch-title" title="' +
              esc(e.title) +
              '">' +
              esc(e.title) +
              "</span>" +
              "</div>"
          )
          .join("");
      } else {
        watchPanel.hidden = true;
        watchHeadline.textContent = "";
        watchHotfix.textContent = "";
        watchList.innerHTML = "";
      }
    }

    const parts = [];
    if (state.login) parts.push("<strong>@" + esc(state.login) + "</strong>");
    if (!state.login && !state.loadError && !state.listLoading) {
      parts.push('Sign in: run <code>gh auth login</code>, or use <strong>"Hotfix: Set GitHub token"</strong>.');
    }
    if (parts.length === 0 && state.listLoading) {
      meta.innerHTML = '<span class="skeleton skeleton-meta" aria-label="Loading"></span>';
    } else {
      meta.innerHTML = parts.join(" · ");
    }

    const pillHtml = [];
    if (state.deployRunning) {
      pillHtml.push(
        '<span class="pill live" title="Workflow has been dispatched on GitHub — Stop is disabled to avoid orphaning the run.">🚀 Deploy running · Stop disabled</span>'
      );
    } else if (state.watching) {
      pillHtml.push('<span class="pill live">👀 Live watch</span>');
    }
    if (state.loadError) {
      pillHtml.push('<span class="pill err">⚠ ' + esc(state.loadError) + "</span>");
    }
    pills.innerHTML = pillHtml.join("") || '<span class="pill">Pick PRs → Start watching</span>';

    const searchRow = document.getElementById("searchRow");
    if (searchRow) {
      searchRow.classList.toggle("is-disabled", Boolean(state.listLoading));
    }

    const sel = new Set(state.selected);
    const src = typeof state.sourceRowCount === "number" ? state.sourceRowCount : 0;

    if (state.listLoading) {
      list.innerHTML =
        '<div class="list-loader" role="status" aria-busy="true">' +
        '<div class="list-loader-spinner"></div>' +
        '<div class="list-loader-label">Loading pull requests…</div>' +
        "</div>";
      return;
    }

    if (src === 0) {
      list.innerHTML =
        '<div class="open-hint">No PRs yet.<br/>Sign in with <code>gh auth login</code>, check <strong>Hotfix › Owner</strong> / <strong>Repo</strong> in settings, then hit <strong>Refresh</strong>.</div>';
      return;
    }
    if (!state.rows.length) {
      const q = (state.searchQuery || "").trim();
      const pv = state.prListView;
      const statusOnly = pv && pv.statusFilter !== "all";
      if (q) {
        list.innerHTML =
          '<div class="open-hint">No PRs match <strong>' +
          esc(q) +
          "</strong>. Try different keywords — checked PRs stay visible when they match your list.</div>";
      } else if (statusOnly) {
        list.innerHTML =
          '<div class="open-hint">No PRs match this <strong>status</strong> filter. Try <strong>All</strong> or pick another option.</div>';
      } else {
        list.innerHTML =
          '<div class="open-hint">Nothing to show. Adjust search or filters — checked PRs stay listed when they are in your refresh set.</div>';
      }
      return;
    }
    list.innerHTML = state.rows
      .map((row) => {
        const checked = sel.has(row.number) ? "checked" : "";
        return (
          '<div class="card" data-num="' +
          row.number +
          '">' +
          '<label class="pick"><input type="checkbox" data-role="cb" data-num="' +
          row.number +
          '" ' +
          checked +
          " /></label>" +
          '<div class="main">' +
          '<div class="topline">' +
          badge(row) +
          '<span class="num">#' +
          row.number +
          "</span>" +
          "</div>" +
          '<div class="titleline"><a class="title" href="#" data-url="' +
          esc(row.htmlUrl) +
          '" title="' +
          esc(row.title) +
          '">' +
          esc(row.title) +
          "</a></div>" +
          "</div>" +
          "</div>"
        );
      })
      .join("");

    list.querySelectorAll('input[data-role="cb"]').forEach((el) => {
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
      });
      el.addEventListener("change", (ev) => {
        const t = ev.target;
        const n = Number(t.getAttribute("data-num"));
        vscode.postMessage({ command: "toggle", number: n });
      });
    });
    list.querySelectorAll("a.title").forEach((a) => {
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const url = a.getAttribute("data-url");
        if (url) vscode.postMessage({ command: "open", url });
      });
    });
    list.querySelectorAll(".card").forEach((c) => {
      c.addEventListener("click", (ev) => {
        const t = ev.target;
        if (t.closest && (t.closest("a") || t.closest("input"))) return;
        const n = Number(c.getAttribute("data-num"));
        if (!Number.isFinite(n) || n <= 0) return;
        vscode.postMessage({ command: "toggle", number: n });
      });
    });
  }

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg && msg.type === "state" && msg.state) {
      if (msg.githubScheme === "light" || msg.githubScheme === "dark") {
        document.body.setAttribute("data-gh-scheme", msg.githubScheme);
      }
      render(msg.state);
    }
  });
  vscode.postMessage({ command: "ready" });
})();
